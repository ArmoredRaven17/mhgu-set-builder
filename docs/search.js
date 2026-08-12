/* search.js — the simplified set search. Pure: no DOM, no timers, Node- and
 * Worker-loadable.
 *
 * Lessons from Athena's ASS are applied as concepts, not code:
 *   - relevance filter: a piece must serve a requested skill, carry Torso Up,
 *     or tie the best slot count for its body part (Armor::MatchesQuery);
 *   - dominance pruning between the survivors — but TRUE dominance (>= on
 *     every requested tree, slots, torso flag and defense, > somewhere), not
 *     her heuristic with efficiency fudge factors;
 *   - "judge, don't re-implement": every candidate that survives the cheap
 *     bound is finalized with an EXACT decoration fill and then verified by
 *     SBEngine.compute, so search results can never disagree with the
 *     builder's own math (her search and display paths disagreed).
 * Her greedy socketing with overkill clamps is replaced by an exact fill —
 * bins are the slot-bearing positions, gems are the best jewel per
 * (tree, size), and a memoized DFS either proves the deficit fillable or not.
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
  const PROGRESS_EVERY = 4000;  // leaves between progress callbacks

  // Every talisman the roll tables allow for these trees, up to a rarity cap.
  //
  // Sweeping EVERY rarity up to the cap matters: the tiers roll different
  // skills in the first and second position, so a higher tier is not simply a
  // better version of a lower one. Attack, for instance, rolls as a Pawn's
  // first skill (1-4) but on a Creator only as a second skill — a one-skill
  // Attack talisman exists at low rarity and nowhere else. Duplicates are
  // folded onto the lowest rarity that can produce them, since that is the
  // easiest one to actually obtain.
  //
  // twoSkill pairs the targets; with no legal pair it falls back to one-skill
  // talismans so the mode is never a dead end.
  function generateTalismans(trees, charm, opts) {
    const maxRar = opts.maxRar || 10;
    const maxSlots = opts.maxSlots == null ? 3 : opts.maxSlots;
    const slotOpts = [0, 1, 2, 3].filter(s => s <= maxSlots);
    const byKey = new Map();
    const keep = tal => {
      const key = tal.sk.map(e => e.join(":")).join("|") + "/" + tal.slots;
      const prev = byKey.get(key);
      if (!prev || tal.rar < prev.rar) byKey.set(key, tal);
    };
    for (let rar = 1; rar <= maxRar; rar++) {
      const table = (charm.tiers || {})[g.SBEngine.TAL_TIER[rar]] || {};
      const canFirst = t => table[t] && (table[t][0] !== 0 || table[t][1] !== 0);
      const canSecond = t => table[t] && (table[t][2] !== 0 || table[t][3] !== 0);
      const firsts = trees.filter(canFirst);
      let paired = false;
      if (opts.twoSkill) {
        for (const t1 of firsts) for (const t2 of trees) {
          if (t2 === t1 || !canSecond(t2) || table[t2][3] <= 0) continue;
          paired = true;
          for (const s of slotOpts)
            keep({ rar, slots: s, sk: [[t1, table[t1][1]], [t2, table[t2][3]]] });
        }
      }
      if (!opts.twoSkill || !paired) {
        for (const t of firsts) for (const s of slotOpts)
          keep({ rar, slots: s, sk: [[t, table[t][1]]] });
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
      const vec = ({ a }) => {
        const v = trees.map(t => { const s = a.sk.find(([tr]) => tr === t); return s ? s[1] : 0; });
        v.push(a.slots, a.sk.some(([tr]) => tr === TORSO_UP) ? 1 : 0, a.lv[Math.min(a.maxLv, a.lv.length) - 1]);
        return v;
      };
      const relevant = pool.filter(({ a }) =>
        a.sk.some(([tr, p]) => need[tr] && p > 0) ||
        a.sk.some(([tr]) => tr === TORSO_UP) ||
        a.slots >= maxSlots);
      const withVec = relevant.map(c => ({ ...c, v: vec(c) }));
      const kept = withVec.filter(c => !withVec.some(o =>
        o !== c &&
        o.v.every((x, i) => x >= c.v[i]) &&
        (o.v.some((x, i) => x > c.v[i]) || o.id < c.id)));   // id-tiebreak kills exact duplicates
      cands[slot] = kept;
      if (!kept.length) return { results: [], complete: true, explored: 0, emptySlot: slot };
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

    // Suffix maxima for the branch-and-bound: from slot k onward, the most
    // points any single choice could add per tree, and the most slots.
    const order = SLOTS;
    const sufPts = [], sufSlots = [];
    sufPts[order.length] = Object.fromEntries(trees.map(t => [t, 0]));
    sufSlots[order.length] = 0;
    for (let k = order.length - 1; k >= 0; k--) {
      const p = { ...sufPts[k + 1] };
      let best = 0;
      for (const t of trees) {
        let m = 0;
        for (const c of cands[order[k]]) {
          const sk = c.a.sk.find(([tr]) => tr === t);
          let pts = sk && sk[1] > 0 ? sk[1] : 0;
          if (order[k] === "chest" || c.a.sk.some(([tr]) => tr === TORSO_UP)) pts *= OPTIMISTIC_TORSO;
          if (pts > m) m = pts;
        }
        p[t] += m;
      }
      for (const c of cands[order[k]]) best = Math.max(best, c.a.slots);
      sufPts[k] = p; sufSlots[k] = sufSlots[k + 1] + best;
    }

    // ── DFS with optimistic bound ─────────────────────────────────────────
    const results = [];
    let explored = 0, leaves = 0, truncated = false, cancelled = false;
    const chosen = new Array(order.length).fill(null);

    const dfs = k => {
      if (cancelled || results.length >= maxResults) { truncated = truncated || results.length >= maxResults; return; }
      if (k === order.length) {
        finalize();
        if (++leaves % PROGRESS_EVERY === 0) {
          if (hooks.progress) hooks.progress({ explored, found: results.length });
          if (hooks.cancelled && hooks.cancelled()) cancelled = true;
        }
        return;
      }
      for (const c of cands[order[k]]) {
        chosen[k] = c;
        // query.noBound is test-only: it proves the bound never prunes a set
        // the unbounded search would have found.
        if (query.noBound) { dfs(k + 1); if (cancelled || results.length >= maxResults) return; continue; }
        // Optimistic bound: current picks (chest ×5) + best future per tree
        // + every reachable slot filled with the densest gem + talisman + 2.
        let ok = true;
        let slotsNow = query.weaponSlots;
        for (let i = 0; i <= k; i++) slotsNow += chosen[i].a.slots;
        const slotsOpt = slotsNow + sufSlots[k + 1] + talMaxSlots;
        for (const t of trees) {
          let have = talBest[t];
          for (let i = 0; i <= k; i++) {
            const sk = chosen[i].a.sk.find(([tr]) => tr === t);
            if (!sk) continue;
            have += order[i] === "chest" ? sk[1] * OPTIMISTIC_TORSO : sk[1];
          }
          if (have + sufPts[k + 1][t] + slotsOpt * OPTIMISTIC_TORSO * density[t] + 2 < need[t]) { ok = false; break; }
        }
        if (ok) dfs(k + 1);
        if (cancelled || results.length >= maxResults) return;
      }
      chosen[k] = null;
    };
    dfs(0);

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

      for (const tal of talCands) {
        const talMult = talDoubled ? 2 : 1;
        const deficit = {};
        for (const t of trees) {
          let have = armorBase[t] || 0;
          if (tal) for (const [tt, p] of tal.sk) if (tt === t) have += p * talMult;
          // Secret Arts gives +2 to every tree that ends up nonzero. A target
          // tree always does — either it already has points, or gems are about
          // to give it some — so the +2 counts here exactly as the engine
          // applies it afterwards.
          if (skillPlus2) have += 2;
          if (have < need[t]) deficit[t] = need[t] - have;
        }

        // Bins, multiplied ones first so the fill favors them.
        const bins = [];
        if (pieces.chest.a.slots) bins.push({ key: "chest", cap: pieces.chest.a.slots, mult });
        if (tal && tal.slots) bins.push({ key: "talisman", cap: tal.slots, mult: talMult });
        for (const slot of ["head", "arms", "waist", "legs"])
          if (pieces[slot].a.slots) bins.push({ key: slot, cap: pieces[slot].a.slots, mult: 1 });
        if (query.weaponSlots) bins.push({ key: "weapon", cap: query.weaponSlots, mult: 1 });
        bins.sort((a, b) => b.mult - a.mult || b.cap - a.cap);

        const fill = exactFill(deficit, bins, gems);
        if (!fill) continue;

        // Materialize and let the engine be the judge.
        const set = {
          pieces: Object.fromEntries(order.map(slot =>
            [slot, { id: pieces[slot].id, lv: 0, decos: fill[slot] || [] }])),
          weapon: query.weaponSlots ? { slots: query.weaponSlots, def: 0, decos: fill.weapon || [] } : null,
          talisman: tal
            ? { rar: tal.rar, slots: tal.slots, sk: tal.sk.map(e => e.slice()), decos: fill.talisman || [] }
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
    return { results, complete: !truncated && !cancelled, cancelled, explored };
  }

  // Exact decoration fill: can `deficit` be covered by jewels in `bins`?
  // Bins are few (<= 7) and caps tiny (<= 3), so a memoized DFS over
  // (bin index, remaining deficit) is exact and instant. Returns
  // { binKey: [decoId, ...] } or null.
  function exactFill(deficit, bins, gems) {
    const trees = Object.keys(deficit).map(Number).filter(t => deficit[t] > 0);
    if (!trees.length) return {};
    const dead = new Set();   // memoized infeasible states
    const stateKey = (i, d) => i + "|" + trees.map(t => Math.max(0, d[t])).join(",");
    const loadoutCache = new Map();

    // Per-bin loadout options: every way to pack gems for the target trees
    // into `cap` slots, fullest first.
    function loadouts(cap, mult) {
      const ck = cap + "x" + mult;
      if (loadoutCache.has(ck)) return loadoutCache.get(ck);
      const out = [];
      const step = (capLeft, startTree, ids, pts) => {
        out.push({ ids: ids.slice(), pts: { ...pts } });
        for (let ti = startTree; ti < trees.length; ti++) {
          const t = trees[ti];
          for (const [sizeStr, gm] of Object.entries(gems[t])) {
            const size = Number(sizeStr);
            if (size > capLeft) continue;
            ids.push(gm.id);
            pts[t] = (pts[t] || 0) + gm.pts * mult;
            step(capLeft - size, ti, ids, pts);
            ids.pop();
            pts[t] -= gm.pts * mult;
          }
        }
      };
      step(cap, 0, [], {});
      const sum = o => Object.values(o.pts).reduce((x, y) => x + y, 0);
      out.sort((a, b) => sum(b) - sum(a));
      loadoutCache.set(ck, out);
      return out;
    }

    const placement = {};
    const dfs = (i, d) => {
      if (trees.every(t => d[t] <= 0)) return true;
      if (i === bins.length) return false;
      const key = stateKey(i, d);
      if (dead.has(key)) return false;
      const bin = bins[i];
      for (const opt of loadouts(bin.cap, bin.mult)) {
        const nd = { ...d };
        for (const t of trees) nd[t] = d[t] - (opt.pts[t] || 0);
        if (dfs(i + 1, nd)) {
          if (opt.ids.length) placement[bin.key] = opt.ids;
          return true;
        }
      }
      dead.add(key);
      return false;
    };
    return dfs(0, { ...deficit }) ? placement : null;
  }

  g.SBSearch = { search, generateTalismans, talCost };
})(typeof window !== "undefined" ? window : globalThis);
