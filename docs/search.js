/* search.js — the simplified set search. Pure: no DOM, no timers, Node- and
 * Worker-loadable.
 *
 * Lessons from Athena's ASS are applied as concepts, not code:
 *   - relevance filter: a piece must serve a requested skill, carry Torso Up,
 *     or tie the best slot count for its body part (Armor::MatchesQuery);
 *   - dominance pruning between the survivors — but TRUE dominance (>= on
 *     every requested tree, slots and the Torso Up flag, > somewhere), not
 *     her heuristic with efficiency fudge factors;
 *   - "judge, don't re-implement": every set that survives is verified by
 *     SBEngine.compute before it is shown, so search results can never
 *     disagree with the builder's own math (her search and display paths
 *     disagreed, which is one source of her "a point or two off" sets).
 *
 * Her greedy socketing with overkill clamps is replaced by an exact solve.
 * Rather than re-solving the gems for every talisman, each armor combination
 * is reduced ONCE to a Pareto front of coverage vectors — what its slots can
 * contribute, clamped at what is still missing, since surplus never helps —
 * and each talisman is then a lookup against that front. That is what keeps a
 * thousand-candidate search in the tens of milliseconds.
 *
 * Talismans are candidates, tried cheapest-first per armor combination: either
 * every talisman the roll tables allow for the targeted skills, or the user's
 * own stored ones. "No talisman" is always the cheapest candidate, so a set
 * that needs none is reported as needing none.
 */
(function (g) {
  "use strict";
  const SLOTS = ["head", "chest", "arms", "waist", "legs"];
  const TORSO_UP = 203, SECRET_ARTS = 204, TALISMAN_BOOST = 205;
  const OPTIMISTIC_TORSO = 5;   // bound-only chest multiplier (1 + up to 4 pieces)
  const PROGRESS_EVERY = 400;   // leaves between progress callbacks and cancel checks

  // Every talisman the roll tables allow for these trees — as points and slots,
  // which is all a set actually cares about. Rarity is not an input: it is
  // derived, because a given (skills, points, slots) talisman is obtainable if
  // ANY tier can roll it, and the lowest such tier is the easiest to hunt.
  //
  // The full point ladder is enumerated, not just each tier's maximum, so the
  // search can report the *minimum* talisman a set needs rather than the
  // strongest one that would also work.
  //
  // Position matters: the tiers roll different skills first and second, so a
  // higher tier is not a better version of a lower one — Attack rolls as a
  // Pawn's first skill (1-4) but on a Creator only as a second, which is why a
  // one-skill Attack talisman tops out at +4.
  //
  // twoSkill widens the pool rather than replacing it: one-skill talismans are
  // strictly easier to obtain, so they stay in, and cost ordering picks them
  // when they suffice.
  const GEN_CAP = 40000;   // safety valve; never reached by five targets
  function generateTalismans(trees, charm, opts) {
    const maxSlots = opts.maxSlots == null ? 3 : opts.maxSlots;
    const slotOpts = [0, 1, 2, 3].filter(s => s <= maxSlots);
    const byKey = new Map();
    const keep = tal => {
      if (byKey.size >= GEN_CAP) return;
      const key = tal.sk.map(e => e.join(":")).join("|") + "/" + tal.slots;
      const prev = byKey.get(key);
      if (!prev || tal.rar < prev.rar) byKey.set(key, tal);
    };
    for (let rar = 1; rar <= 10; rar++) {
      const table = (charm.tiers || {})[g.SBEngine.TAL_TIER[rar]] || {};
      // Positive ranges only: a talisman that rolls a malus is never something
      // to go hunting for.
      const range = (t, pos) => {
        const row = table[t];
        if (!row) return null;
        const lo = row[pos], hi = row[pos + 1];
        return hi > 0 ? [Math.max(1, lo), hi] : null;
      };
      for (const t of trees) {
        const r1 = range(t, 0);
        if (!r1) continue;
        for (let p = r1[0]; p <= r1[1]; p++)
          for (const s of slotOpts) keep({ rar, slots: s, sk: [[t, p]], gen: true });
      }
      if (!opts.twoSkill) continue;
      for (const t1 of trees) {
        const r1 = range(t1, 0);
        if (!r1) continue;
        for (const t2 of trees) {
          if (t2 === t1) continue;
          const r2 = range(t2, 2);
          if (!r2) continue;
          for (let p1 = r1[0]; p1 <= r1[1]; p1++)
            for (let p2 = r2[0]; p2 <= r2[1]; p2++)
              for (const s of slotOpts) keep({ rar, slots: s, sk: [[t1, p1], [t2, p2]], gen: true });
        }
      }
    }
    return [...byKey.values()].sort((a, b) => talCost(a) - talCost(b) || a.rar - b.rar);
  }

  // How demanding a talisman is to actually own — used to try the modest ones
  // first, so a set that needs less is found and ranked first.
  const talCost = tal => (tal ? tal.sk.reduce((n, [, p]) => n + Math.abs(p), 0) + tal.slots * 2 : 0);

  // query = {
  //   targets: [[treeId, points], ...],       activation thresholds to reach
  //   gender: 0|1, cls: "B"|"G", maxRar: 1..11, weaponSlots: 0..3,
  //   talismans: [{rar, slots, sk}, ...],     candidates (see generateTalismans)
  //   allowNoTalisman: bool (default true),   include "no talisman" candidate
  //   maxResults: cap (default 50),
  // }
  // hooks = { progress(state), cancelled() } — both optional, both synchronous.
  function search(query, data, hooks) {
    hooks = hooks || {};
    const need = {};
    for (const [t, p] of query.targets) need[t] = Math.max(need[t] || 0, p);
    const trees = Object.keys(need).map(Number);
    const maxResults = query.maxResults || 50;
    if (!trees.length) return { results: [], complete: true, explored: 0 };

    // Talisman candidates, cheapest first. "None" leads unless excluded.
    const talCands = (query.allowNoTalisman === false ? [] : [null])
      .concat(query.talismans || [])
      .sort((a, b) => talCost(a) - talCost(b));

    // Best jewel per (tree, size) — and each tree's best points-per-slot for
    // the optimistic bound.
    const gems = {}, density = {};
    for (const t of trees) {
      gems[t] = {};
      for (const [id, d] of Object.entries(data.decos)) {
        const sk = d.sk.find(([tr, p]) => tr === t && p > 0);
        if (!sk) continue;
        const cur = gems[t][d.slots];
        if (!cur || sk[1] > cur.pts) gems[t][d.slots] = { id: Number(id), pts: sk[1] };
      }
      density[t] = Math.max(0, ...Object.entries(gems[t]).map(([s, gm]) => gm.pts / Number(s)));
    }

    // ── Candidates per slot: relevance filter, then true dominance ────────
    const cands = {};
    for (const slot of SLOTS) {
      const pool = Object.entries(data.armor[slot])
        .map(([id, a]) => ({ id: Number(id), a }))
        .filter(({ a }) =>
          (a.gender === 2 || a.gender === query.gender) &&
          (a.cls === "A" || a.cls === query.cls) &&
          a.rar <= query.maxRar);
      const maxSlots = Math.max(0, ...pool.map(({ a }) => a.slots));
      // Dominance is judged on what decides whether a set WORKS: points in the
      // targeted trees, decoration slots, and Torso Up. Defense is deliberately
      // not part of it — including it made almost every piece incomparable
      // (nothing dominates a piece with one more defense), which collapsed the
      // pruning and left the search wading through hundreds of pieces per slot.
      // It is kept only to choose the representative among equals.
      const vec = ({ a }) => {
        const v = trees.map(t => { const s = a.sk.find(([tr]) => tr === t); return s ? s[1] : 0; });
        v.push(a.slots, a.sk.some(([tr]) => tr === TORSO_UP) ? 1 : 0);
        return v;
      };
      const def = ({ a }) => a.lv[Math.min(a.maxLv, a.lv.length) - 1];
      const relevant = pool.filter(({ a }) =>
        a.sk.some(([tr, p]) => need[tr] && p > 0) ||
        a.sk.some(([tr]) => tr === TORSO_UP) ||
        a.slots >= maxSlots);
      const withVec = relevant.map(c => ({ ...c, v: vec(c), def: def(c) }));
      const kept = withVec.filter(c => !withVec.some(o =>
        o !== c &&
        o.v.every((x, i) => x >= c.v[i]) &&
        (o.v.some((x, i) => x > c.v[i]) ||
         o.def > c.def || (o.def === c.def && o.id < c.id))));   // keep the sturdiest of equals
      // Dense per-candidate vectors: the hot loops must never search a piece's
      // skill list, and the bound must never rebuild a running total.
      cands[slot] = kept.map(c => ({
        id: c.id, a: c.a,
        pts: trees.map(t => { const s = c.a.sk.find(([tr]) => tr === t); return s ? s[1] : 0; }),
        slots: c.a.slots,
        torso: c.a.sk.some(([tr]) => tr === TORSO_UP) ? 1 : 0,
      }));
      // Richest pieces first: with a result cap, finding viable sets early is
      // what lets the search stop early.
      cands[slot].sort((x, y) =>
        y.pts.reduce((a, b) => a + b, 0) + y.slots * 2 - (x.pts.reduce((a, b) => a + b, 0) + x.slots * 2));
      if (!cands[slot].length) return { results: [], complete: true, explored: 0, emptySlot: slot };
    }

    // Optimistic talisman help, for the bound only: the best any candidate
    // could give per tree (doubled, in case Talisman Boost is up) and the most
    // slots any of them carries.
    const talBest = Object.fromEntries(trees.map(t => [t, 0]));
    let talMaxSlots = 0;
    for (const tal of talCands) {
      if (!tal) continue;
      talMaxSlots = Math.max(talMaxSlots, tal.slots);
      for (const [t, p] of tal.sk)
        if (t in talBest) talBest[t] = Math.max(talBest[t], p * 2);
    }
    // Dense per-candidate vectors, so the per-leaf scan never walks a skill
    // list: contribution per target tree, and slot count.
    const talContrib = talCands.map(tal =>
      trees.map(t => {
        let p = 0;
        if (tal) for (const [tt, pp] of tal.sk) if (tt === t) p += pp;
        return p;
      }));
    const talSlots = talCands.map(tal => (tal ? tal.slots : 0));
    // The most total points any single candidate can put into the targets —
    // an upper bound on talisman help for the leaf filter.
    let talBestSum = 0;
    for (const c of talContrib) {
      let s = 0;
      for (const p of c) s += p;
      if (s > talBestSum) talBestSum = s;
    }

    // Suffix maxima for the branch-and-bound: from slot k onward, the most
    // points any single choice could add per tree, and the most slots.
    const order = SLOTS;
    const sufPts = [], sufSlots = [];
    sufPts[order.length] = trees.map(() => 0);
    sufSlots[order.length] = 0;
    for (let k = order.length - 1; k >= 0; k--) {
      const p = sufPts[k + 1].slice();
      let best = 0;
      const chestish = order[k] === "chest";
      for (let ti = 0; ti < trees.length; ti++) {
        let m = 0;
        for (const c of cands[order[k]]) {
          const pts = c.pts[ti] > 0 ? c.pts[ti] * (chestish || c.torso ? OPTIMISTIC_TORSO : 1) : 0;
          if (pts > m) m = pts;
        }
        p[ti] += m;
      }
      for (const c of cands[order[k]]) if (c.slots > best) best = c.slots;
      sufPts[k] = p; sufSlots[k] = sufSlots[k + 1] + best;
    }

    // ── DFS with optimistic bound ─────────────────────────────────────────
    // Everything in this loop is indexed by target-tree position and carried
    // incrementally: the bound is O(targets) per node, not O(depth × targets).
    const needArr = trees.map(t => need[t]);
    const talBestArr = trees.map(t => talBest[t]);
    const densityArr = trees.map(t => density[t]);
    const results = [];
    const loadoutTable = new Map();   // (cap x multiplier) -> packings, per search
    const frontCache = new Map();     // (slot layout, remaining gap) -> coverage front
    const acc = trees.map(() => 0);
    let explored = 0, leaves = 0, truncated = false, cancelled = false, timedOut = false;
    let nodes = 0, fills = 0;   // diagnostics
    const chosen = new Array(order.length).fill(null);
    const deadline = query.timeBudgetMs ? Date.now() + query.timeBudgetMs : Infinity;

    const stop = () => cancelled || timedOut || results.length >= maxResults;
    const dfs = (k, accSlots) => {
      if (stop()) { truncated = truncated || results.length >= maxResults; return; }
      if (k === order.length) {
        finalize();
        if (++leaves % PROGRESS_EVERY === 0) {
          if (hooks.progress) hooks.progress({ explored, found: results.length });
          if (hooks.cancelled && hooks.cancelled()) cancelled = true;
          if (Date.now() > deadline) timedOut = true;
        }
        return;
      }
      nodes++;
      const list = cands[order[k]];
      const chestish = order[k] === "chest";
      for (const c of list) {
        const m = chestish ? OPTIMISTIC_TORSO : 1;
        for (let ti = 0; ti < acc.length; ti++) acc[ti] += c.pts[ti] * m;
        chosen[k] = c;
        const slotsNow = accSlots + c.slots;
        let ok = true;
        if (!query.noBound) {
          // Optimistic bound: what is banked (chest ×5) + the best any later
          // slot could add + every reachable slot filled with the densest gem
          // + the strongest talisman + Secret Arts.
          const slotsOpt = slotsNow + query.weaponSlots + sufSlots[k + 1] + talMaxSlots;
          const suf = sufPts[k + 1];
          let totalGap = 0, bestDensity = 0, shortTrees = 0;
          for (let ti = 0; ti < acc.length; ti++) {
            const have = acc[ti] + talBestArr[ti] + suf[ti];
            if (have + slotsOpt * OPTIMISTIC_TORSO * densityArr[ti] + 2 < needArr[ti]) { ok = false; break; }
            const short = needArr[ti] - have;
            if (short > 0) {
              totalGap += short;
              shortTrees++;
              if (densityArr[ti] > bestDensity) bestDensity = densityArr[ti];
            }
          }
          // The tests above each assume every slot serves that one skill. Slots
          // are shared, so several skills competing for a few slots slips
          // through them — this catches it, and it is what makes a demanding
          // query with no weapon slots finish instead of grinding.
          if (ok && totalGap > slotsOpt * OPTIMISTIC_TORSO * bestDensity + 2 * shortTrees) ok = false;
        }
        if (ok) dfs(k + 1, slotsNow);
        for (let ti = 0; ti < acc.length; ti++) acc[ti] -= c.pts[ti] * m;
        if (stop()) return;
      }
      chosen[k] = null;
    };
    dfs(0, 0);

    // ── Finalize: exact sums, cascade flags, exact gem fill, engine check ─
    // Talismans are tried cheapest-first; the first that works is the answer
    // for this armor combination, so one combination yields one result.
    function finalize() {
      explored++;
      const pieces = {};
      order.forEach((slot, i) => { pieces[slot] = chosen[i]; });
      const torsoCount = order.reduce((n, slot, i) =>
        n + (chosen[i].a.sk.some(([tr]) => tr === TORSO_UP) ? 1 : 0), 0);
      const mult = 1 + torsoCount;

      // Armor-only base points (204/205 live on armor alone, so the cascade
      // flags below are exact before any talisman is considered).
      const armorBase = {};
      order.forEach((slot, i) => {
        for (const [tr, p] of chosen[i].a.sk)
          if (tr !== TORSO_UP) armorBase[tr] = (armorBase[tr] || 0) + (slot === "chest" ? p * mult : p);
      });
      const skillPlus2 = (armorBase[SECRET_ARTS] || 0) >= 10;
      const boostRaw = armorBase[TALISMAN_BOOST] || 0;
      const talDoubled = (boostRaw + (skillPlus2 && boostRaw ? 2 : 0)) >= 10;
      const talMult = talDoubled ? 2 : 1;

      // What the armor alone leaves outstanding. Secret Arts gives +2 to every
      // tree that ends up nonzero, and a target tree always does — either it
      // has points already or gems are about to give it some — so the +2 counts
      // here exactly as the engine applies it afterwards.
      let armorSlots = 0;
      for (const slot of SLOTS) armorSlots += pieces[slot].a.slots;
      const gapArr = trees.map((t, ti) =>
        needArr[ti] - ((armorBase[t] || 0) + (skillPlus2 ? 2 : 0)));

      // Hopeless leaves are skipped without touching the fill solver: not even
      // the strongest candidate plus every slot filled with the densest gem
      // could close the gap.
      const slotCeiling = armorSlots + query.weaponSlots + talMaxSlots;
      let totalGap = 0, bestDensity = 0, shortTrees = 0;
      for (let ti = 0; ti < trees.length; ti++) {
        if (gapArr[ti] > talBestArr[ti] + slotCeiling * (1 + torsoCount) * densityArr[ti]) return;
        if (gapArr[ti] > 0) {
          totalGap += gapArr[ti];
          shortTrees++;
          if (densityArr[ti] > bestDensity) bestDensity = densityArr[ti];
        }
      }
      // Same shared-slot argument as in the bound, with this leaf's exact
      // numbers: if everything still missing outweighs what every slot and the
      // most generous talisman could supply, no arrangement exists, and the
      // coverage front is never built. Most leaves of a demanding query die
      // here, which is what keeps them cheap.
      if (totalGap > slotCeiling * (1 + torsoCount) * bestDensity + talBestSum * talMult + 2 * shortTrees) return;

      // Candidates whose *effective* help is identical are the same problem, so
      // each distinct (clamped contribution, slots) is solved once. With the
      // list sorted cheapest-first, the first one seen for a key is the most
      // modest talisman that could deliver it.
      // The gem problem is solved ONCE per armor combination, not once per
      // talisman: the armor and weapon slots yield a Pareto front of coverage
      // vectors (clamped at the gap, since surplus points never help), and each
      // talisman slot count extends that front by its own bin. A candidate is
      // then a lookup — does some vector cover what the talisman doesn't — with
      // no solver call at all. This is what took the hard queries from 11,000
      // fills per search to a handful.
      const armorBins = [];
      if (pieces.chest.a.slots) armorBins.push({ key: "chest", cap: pieces.chest.a.slots, mult });
      for (const slot of ["head", "arms", "waist", "legs"])
        if (pieces[slot].a.slots) armorBins.push({ key: slot, cap: pieces[slot].a.slots, mult: 1 });
      if (query.weaponSlots) armorBins.push({ key: "weapon", cap: query.weaponSlots, mult: 1 });
      // Coverage is clamped at what is still MISSING, never at a negative gap:
      // a tree the armor already satisfies needs zero further cover, and
      // clamping to a negative number would make every vector fail the test.
      const clampAt = gapArr.map(gp => (gp > 0 ? gp : 0));
      // Armor combinations repeat their slot layout and their remaining gap
      // constantly, and the front depends on nothing else — so build it once
      // per (layout, gap) and reuse it across leaves.
      const frontKey = armorBins.map(b => b.key + b.cap + "x" + b.mult).join("/") + "|" + clampAt.join(",");
      let baseFront = frontCache.get(frontKey);
      if (!baseFront) {
        fills++;
        baseFront = coverageFront(armorBins, clampAt, trees, gems, loadoutTable);
        frontCache.set(frontKey, baseFront);
      }
      const frontFor = [];   // by talisman slot count
      const frontOf = s => {
        if (frontFor[s] === undefined) {
          frontFor[s] = s > 0
            ? extendFront(baseFront, { key: "talisman", cap: s, mult: talMult }, clampAt, trees, gems, loadoutTable)
            : baseFront;
        }
        return frontFor[s];
      };

      const tried = new Set();
      for (let ci = 0; ci < talCands.length; ci++) {
        const tal = talCands[ci];
        const contrib = talContrib[ci];
        // What this talisman leaves for the gems to cover.
        let key = "";
        const residual = [];
        for (let ti = 0; ti < trees.length; ti++) {
          const left = gapArr[ti] - contrib[ti] * talMult;
          residual.push(left > 0 ? left : 0);
          key += (left > 0 ? left : 0) + ",";
        }
        key += "|" + talSlots[ci];
        if (tried.has(key)) continue;
        tried.add(key);

        const hit = frontOf(talSlots[ci]).find(v => {
          for (let ti = 0; ti < trees.length; ti++) if (v.pts[ti] < residual[ti]) return false;
          return true;
        });
        if (!hit) continue;
        const fill = hit.place;

        // Materialize and let the engine be the judge.
        const set = {
          pieces: Object.fromEntries(order.map(slot =>
            [slot, { id: pieces[slot].id, lv: 0, decos: fill[slot] || [] }])),
          weapon: query.weaponSlots ? { slots: query.weaponSlots, def: 0, decos: fill.weapon || [] } : null,
          talisman: tal
            ? { rar: tal.rar, slots: tal.slots, sk: tal.sk.map(e => e.slice()), decos: fill.talisman || [], gen: !!tal.gen }
            : null,
        };
        const r = g.SBEngine.compute({ weapon: set.weapon, pieces: set.pieces, talisman: set.talisman }, data);
        let good = !r.problems.length;
        for (const t of trees) if ((r.treePoints[t] || 0) < need[t]) good = false;
        if (!good) continue;   // engine disagrees with the plan: try the next talisman
        const spare = Object.values(r.slots).reduce((a, s) => a + (s.total - s.used), 0);
        results.push({ set, engine: r, spare, defense: r.defense, talCost: talCost(tal) });
        return;
      }
    }

    results.sort((a, b) => a.talCost - b.talCost || b.spare - a.spare || b.defense - a.defense);
    return { results, complete: !truncated && !cancelled && !timedOut, cancelled, timedOut, explored, stats: { nodes, fills, loadouts: loadoutTable.size } };
  }

  // Every way to pack gems for the target trees into `cap` slots, as dense
  // point vectors. Built ONCE per (cap, multiplier) for a whole search — this
  // used to be rebuilt on every call, which dominated the runtime — and
  // Pareto-pruned, since a packing beaten on every tree by another of the same
  // size can never be the one that makes a set work.
  function buildLoadouts(cap, mult, trees, gems) {
    const raw = [];
    const cur = trees.map(() => 0);
    const step = (capLeft, startTree, ids) => {
      raw.push({ ids: ids.slice(), pts: cur.slice() });
      for (let ti = startTree; ti < trees.length; ti++) {
        const sizes = gems[trees[ti]];
        for (const sizeStr in sizes) {
          const size = Number(sizeStr);
          if (size > capLeft) continue;
          const gm = sizes[sizeStr];
          ids.push(gm.id);
          cur[ti] += gm.pts * mult;
          step(capLeft - size, ti, ids);
          cur[ti] -= gm.pts * mult;
          ids.pop();
        }
      }
    };
    step(cap, 0, []);
    const kept = raw.filter((o, i) => !raw.some((p, j) =>
      j !== i && p.pts.every((x, ti) => x >= o.pts[ti]) &&
      (p.pts.some((x, ti) => x > o.pts[ti]) || p.ids.length < o.ids.length)));
    const sum = o => o.pts.reduce((x, y) => x + y, 0);
    kept.sort((a, b) => sum(b) - sum(a));
    return kept;
  }

  const loadoutsFor = (bin, trees, gems, table) => {
    const ck = bin.cap + "x" + bin.mult;
    let opts = table.get(ck);
    if (!opts) { opts = buildLoadouts(bin.cap, bin.mult, trees, gems); table.set(ck, opts); }
    return opts;
  };

  // Keep only the coverage vectors nothing else beats. Values are clamped at
  // the gap before they get here, so two vectors that both cover a tree fully
  // are the same vector as far as the search is concerned — which is what
  // keeps these fronts small.
  function pareto(list) {
    // Clamping makes many packings identical; folding those together first
    // keeps the quadratic comparison below working on a much shorter list.
    const uniq = new Map();
    for (const v of list) {
      const key = v.pts.join(",");
      const prev = uniq.get(key);
      if (!prev || v.count < prev.count) uniq.set(key, v);
    }
    const out = [];
    list = [...uniq.values()];
    list.sort((a, b) => b.total - a.total || a.count - b.count);
    for (const v of list) {
      let dominated = false;
      for (const k of out) {
        let ge = true;
        for (let i = 0; i < v.pts.length; i++) if (k.pts[i] < v.pts[i]) { ge = false; break; }
        if (ge) { dominated = true; break; }
      }
      if (!dominated) out.push(v);
    }
    return out;
  }
  const vecOf = (pts, place, count) => ({
    pts, place, count,
    total: pts.reduce((a, b) => a + b, 0),
  });

  // One bin's worth of extension: every way to add this bin's gems to each
  // vector already on the front, re-pruned.
  function extendFront(front, bin, gapArr, trees, gems, table) {
    const opts = loadoutsFor(bin, trees, gems, table);
    const next = [];
    for (const f of front) {
      for (const o of opts) {
        const pts = new Array(trees.length);
        for (let ti = 0; ti < trees.length; ti++) {
          const v = f.pts[ti] + o.pts[ti];
          pts[ti] = v > gapArr[ti] ? gapArr[ti] : v;
        }
        next.push(vecOf(pts, o.ids.length ? { ...f.place, [bin.key]: o.ids } : f.place,
          f.count + o.ids.length));
      }
    }
    return pareto(next);
  }

  // Everything the given bins can cover, as a Pareto front of clamped vectors,
  // each carrying the decoration placement that achieves it.
  function coverageFront(bins, gapArr, trees, gems, table) {
    let front = [vecOf(trees.map(() => 0), {}, 0)];
    for (const bin of bins) front = extendFront(front, bin, gapArr, trees, gems, table);
    return front;
  }

  g.SBSearch = { search, generateTalismans, talCost };
})(typeof window !== "undefined" ? window : globalThis);
