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

  // Is a piece craftable at this progression? Athena's table records the
  // Gathering-Hall (hub) star and Village star at which it unlocks, with 99
  // meaning "never from that source" and a flag saying whether BOTH conditions
  // are required or either will do. A piece with no recorded availability
  // (event/collab gear that never matched the table) is always allowed rather
  // than silently withheld.
  function reachable(a, vil, hub) {
    if (a.hub === undefined) return true;
    const byHub = a.hub !== 99 && hub >= a.hub;
    const byVil = a.vil !== 99 && vil >= a.vil;
    return a.andF ? byHub && byVil : byHub || byVil;
  }

  // Does this set actually have the requested skill? Either it has the points,
  // or a Soul handed the skill over directly (the full Redhelm set activates
  // Focus with no Focus points anywhere on it).
  function satisfied(r, tree, pts) {
    if ((r.treePoints[tree] || 0) >= pts) return true;
    return r.active.some(a => a.tree === tree && !a.negative && a.threshold >= pts)
      || r.soulGrants.some(gr => gr.tree === tree && !gr.negative && gr.threshold >= pts);
  }

  // query = {
  //   targets: [[treeId, points], ...],       activation thresholds to reach
  //   gender: 0|1, cls: "B"|"G", maxRar: 1..11, weaponSlots: 0..3,
  //   villageStar: 1..10, hubStar: 1..13,     progression (default: everything)
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

    // A requested skill does not have to come from points in its own tree.
    //
    //  - a Soul grants whole skills outright: the full Redhelm set activates
    //    Focus and Resentment while carrying zero points in either;
    //  - Secret Arts adds +2 to every tree that has any points at all, which
    //    can be what carries a skill over its threshold;
    //  - Talisman Boost doubles what the talisman contributes.
    //
    // Pieces carrying those trees look irrelevant — they hold none of the
    // requested skills — so without this they were filtered out before the
    // search began, and any that survived were pruned as "dominated" by
    // pieces that merely had more of the requested skills. These trees are
    // therefore treated as relevant in their own right.
    const aux = new Set([SECRET_ARTS, TALISMAN_BOOST]);
    for (const [treeStr, byThreshold] of Object.entries(data.souls || {})) {
      for (const grants of Object.values(byThreshold)) {
        if (grants.some(([gTree, gPts]) => need[gTree] !== undefined && gPts >= need[gTree]))
          aux.add(Number(treeStr));
      }
    }
    // Only trees some piece actually carries are worth widening the search for.
    const auxTrees = [...aux].filter(t => !need[t]);
    // Which Souls can hand over each requested skill, and at what threshold.
    // A target on this list can be satisfied without ever earning its points,
    // so the pruning below must not treat missing points as fatal for it.
    const soulFor = trees.map(t => {
      const out = [];
      for (const [treeStr, byThreshold] of Object.entries(data.souls || {}))
        for (const [thr, grants] of Object.entries(byThreshold))
          if (grants.some(([gTree, gPts]) => gTree === t && gPts >= need[t]))
            out.push([Number(treeStr), Number(thr)]);
      return out;
    });
    // Soul trees are carried as extra dimensions alongside the requested
    // skills, so the bound can ask "could this branch still reach the Soul?"
    // instead of simply giving up on pruning that skill — which cost four
    // times the work for the queries no Soul was ever going to serve.
    const soulDims = [...new Set([].concat(...soulFor.map(l => l.map(([t]) => t))))];
    const dims = trees.concat(soulDims);                  // acc/suf/pts space
    const dimNeed = trees.map(t => need[t]).concat(
      soulDims.map(st => Math.min(...soulFor.flat().filter(([t]) => t === st).map(([, thr]) => thr))));
    // For each requested skill, which dimensions are the Souls that grant it.
    const soulDimsFor = soulFor.map(list =>
      list.map(([st]) => trees.length + soulDims.indexOf(st)));

    // Best jewel per (tree, size) — and each tree's best points-per-slot for
    // the optimistic bound.
    const gems = {}, density = {};
    for (const t of dims) {
      gems[t] = {};
      for (const [id, d] of Object.entries(data.decos)) {
        const sk = d.sk.find(([tr, p]) => tr === t && p > 0);
        if (!sk) continue;
        const cur = gems[t][d.slots];
        if (!cur || sk[1] > cur.pts) gems[t][d.slots] = { id: Number(id), pts: sk[1] };
      }
      density[t] = Math.max(0, ...Object.entries(gems[t]).map(([s, gm]) => gm.pts / Number(s)));
    }

    // Three jewels in four carry a malus, and 182 of them dock a skill that
    // other jewels exist to raise — an Earplug Jwl buys Hearing at the cost of
    // Protection. Fitting gems by their headline skill alone quietly proposes
    // loadouts whose side effects knock another requested skill back under its
    // threshold; the engine then rejects the set, and an arrangement that
    // would have worked is never tried. So a jewel is carried as its FULL
    // effect on the requested skills, maluses included.
    //
    // Measured over `dims`, not just the requested skills: a Soul can be
    // bought with jewels (five Yukumo Jwls activate Soul of Yukumo, which hands
    // over Honey Hunter and Water Res +15 outright), so the fill has to be able
    // to aim at a Soul's own tree the same way it aims at a requested one.
    const jewels = [];
    for (const [id, d] of Object.entries(data.decos)) {
      const eff = dims.map(t => {
        let v = 0;
        for (const [tr, p] of d.sk) if (tr === t) v += p;
        return v;
      });
      if (eff.some(v => v > 0)) jewels.push({ id: Number(id), slots: d.slots, eff });
    }

    // ── Candidates per slot: relevance filter, then true dominance ────────
    // Progression defaults to endgame, so an unset query searches everything
    // exactly as before.
    const vil = query.villageStar == null ? 99 : query.villageStar;
    const hub = query.hubStar == null ? 99 : query.hubStar;
    const pools = {};
    for (const slot of SLOTS) {
      pools[slot] = Object.entries(data.armor[slot])
        .map(([id, a]) => ({ id: Number(id), a }))
        .filter(({ a }) =>
          (a.gender === 2 || a.gender === query.gender) &&
          (a.cls === "A" || a.cls === query.cls) &&
          a.rar <= query.maxRar &&
          reachable(a, vil, hub));
    }

    // ── Trace: why is THIS set not in the results? ────────────────────────
    // A set a player already owns is the best bug report there is, but only
    // if it can be followed through the search. Given that set, every stage
    // records whether it survived, so the answer is the name of the stage
    // that dropped it rather than a guess. It costs nothing when unused.
    const trace = query.trace ? { notes: [], reached: {} } : null;
    const tracedId = slot => (trace && query.trace.pieces && query.trace.pieces[slot] != null
      ? Number(query.trace.pieces[slot]) : null);
    if (trace) {
      for (const slot of SLOTS) {
        const id = tracedId(slot);
        const a = id == null ? null : data.armor[slot][id];
        if (!a) { trace.notes.push(`${slot}: no such piece`); continue; }
        if (!(a.gender === 2 || a.gender === query.gender))
          trace.notes.push(`${slot}: ${a.n} is ${a.gender === 0 ? "male" : "female"} only`);
        else if (!(a.cls === "A" || a.cls === query.cls))
          trace.notes.push(`${slot}: ${a.n} is ${a.cls === "B" ? "blademaster" : "gunner"} only`);
        else if (a.rar > query.maxRar)
          trace.notes.push(`${slot}: ${a.n} is rarity ${a.rar}, above the cap of ${query.maxRar}`);
        else if (!reachable(a, vil, hub))
          trace.notes.push(`${slot}: ${a.n} is not craftable at village ${vil} / hub ${hub}`);
        else trace.reached.legal = true;
      }
      if (trace.notes.length) trace.stage = "the wearer, rarity or progression filters";
    }

    // Candidates for one pass. `soulTree` is the Soul this pass cares about,
    // or 0 for the main pass.
    //
    // Which trees count for dominance is what makes or breaks the search.
    // Points in the requested skills, slots and Torso Up always count, and so
    // do Secret Arts and Talisman Boost, since nothing else can replace what
    // they do. A Soul counts ONLY in its own pass: letting every Soul into the
    // comparison made pieces from different Deviant sets mutually incomparable
    // and inflated every pool more than fivefold, for skills most searches
    // never involve. Defense is deliberately excluded — it made almost
    // everything incomparable — and is kept only to pick between equals.
    function buildCands(soulTree) {
      const out = {};
      const extra = [SECRET_ARTS, TALISMAN_BOOST].concat(soulTree ? [soulTree] : []);
      for (const slot of SLOTS) {
        const pool = pools[slot];
        // The stand-in for "a piece with nothing wanted on it" is whichever
        // piece carries the most slots — but it only stands in if it costs
        // nothing, and a piece that DOCKS a requested skill does not stand in
        // for one that leaves it alone. Measuring the bar on those pieces too
        // threw away clean, smaller-slotted pieces that nothing replaced.
        const harmless = ({ a }) => !a.sk.some(([tr, p]) => p < 0 && (need[tr] || extra.includes(tr)));
        const maxSlots = Math.max(0, ...pool.filter(harmless).map(({ a }) => a.slots));
        const vec = ({ a }) => {
          const v = trees.map(t => { const s = a.sk.find(([tr]) => tr === t); return s ? s[1] : 0; });
          for (const t of extra) { const s = a.sk.find(([tr]) => tr === t); v.push(s ? s[1] : 0); }
          v.push(a.slots, a.sk.some(([tr]) => tr === TORSO_UP) ? 1 : 0);
          return v;
        };
        const def = ({ a }) => a.lv[Math.min(a.maxLv, a.lv.length) - 1];
        // A piece earns its place by serving a requested skill, by carrying
        // one of the trees that can deliver a skill on its own, by Torso Up,
        // or by tying the best slot count in its slot — a piece with fewer
        // slots and nothing wanted is dominated by that one. Sound for whether
        // a set is POSSIBLE; `noRelevanceFilter` exists so a test can prove
        // that rather than take it on trust.
        const relevant = query.noRelevanceFilter ? pool : pool.filter(({ a }) =>
          a.sk.some(([tr, p]) => need[tr] && p > 0) ||
          a.sk.some(([tr, p]) => extra.includes(tr) && p > 0) ||
          a.sk.some(([tr]) => tr === TORSO_UP) ||
          a.slots >= maxSlots);
        const withVec = relevant.map(c => ({ ...c, v: vec(c), def: def(c) }));
        // `noDominance` keeps every piece, however plainly outclassed. Far too
        // slow to search with, but it is the only way to ask whether dropping
        // a piece as "outclassed" is what lost a set, rather than assume it.
        const kept = query.noDominance ? withVec : withVec.filter(c => !withVec.some(o =>
          o !== c &&
          o.v.every((x, i) => x >= c.v[i]) &&
          (o.v.some((x, i) => x > c.v[i]) ||
           o.def > c.def || (o.def === c.def && o.id < c.id))));   // keep the sturdiest of equals
        if (trace && !soulTree) {
          const id = tracedId(slot);
          if (id != null && pool.some(c => c.id === id)) {
            if (!relevant.some(c => c.id === id)) {
              trace.notes.push(`${slot}: ${data.armor[slot][id].n} was set aside as holding `
                + "nothing the query asked for and fewer slots than the best piece");
              trace.stage = trace.stage || "the relevance filter";
            } else if (!kept.some(c => c.id === id)) {
              const me = withVec.find(c => c.id === id);
              const by = withVec.find(o => o !== me && o.v.every((x, i) => x >= me.v[i]));
              trace.notes.push(`${slot}: ${data.armor[slot][id].n} was dropped as outclassed`
                + (by ? ` by ${by.a.n}` : ""));
              trace.stage = trace.stage || "the dominance filter";
            }
          }
        }
        // Dense per-candidate vectors: the hot loops must never search a
        // piece's skill list, and the bound must never rebuild a running total.
        out[slot] = kept.map(c => ({
          id: c.id, a: c.a,
          pts: dims.map(t => { const s = c.a.sk.find(([tr]) => tr === t); return s ? s[1] : 0; }),
          slots: c.a.slots,
          torso: c.a.sk.some(([tr]) => tr === TORSO_UP) ? 1 : 0,
        }));
        // Richest pieces first: with a result cap, finding viable sets early is
        // what lets the search stop early.
        out[slot].sort((x, y) =>
          y.pts.reduce((a, b) => a + b, 0) + y.slots * 2 - (x.pts.reduce((a, b) => a + b, 0) + x.slots * 2));
      }
      return out;
    }
    let cands = buildCands(0);
    for (const slot of SLOTS)
      if (!cands[slot].length) return { results: [], complete: true, explored: 0, emptySlot: slot };

    // A Soul is only worth keeping the search open for if the surviving pieces
    // could actually complete it — gender, class, rarity or progression may
    // have taken part of the set away. Where they have, that skill goes back
    // to needing real points, which restores the pruning that relaxing for a
    // Soul necessarily gives up.
    for (let si = 0; si < soulDims.length; si++) {
      const di = trees.length + si;
      const st = soulDims[si];
      // Judged on every piece that survived the wearer's own filters, NOT on
      // the main pass's candidates: that pass compares pieces without regard
      // to Souls, so the Deviant gear needed here has usually been dominated
      // out of it, and asking it would rule out every Soul.
      // Counted the way the set could actually be built: the best armor points,
      // plus every slot in play filled with the densest jewel for that tree,
      // plus the most a talisman could give, plus Secret Arts. A Soul is often
      // gemmed rather than worn — Soul of Yukumo off five Yukumo Jwls — and
      // weighing armor alone here switched those passes off before they ran.
      let best = 0, slotsOpt = query.weaponSlots;
      for (const slot of SLOTS) {
        best += Math.max(0, ...pools[slot].map(({ a }) => {
          const s = a.sk.find(([tr]) => tr === st);
          return s ? s[1] : 0;
        }));
        slotsOpt += Math.max(0, ...pools[slot].map(({ a }) => a.slots));
      }
      let talPts = 0, talSlotsMax = 0;
      for (const tal of talCands) {
        if (!tal) continue;
        if (tal.slots > talSlotsMax) talSlotsMax = tal.slots;
        for (const [t, p] of tal.sk) if (t === st && p * 2 > talPts) talPts = p * 2;
      }
      best += talPts + (slotsOpt + talSlotsMax) * OPTIMISTIC_TORSO * (density[st] || 0) + 2;
      if (best < dimNeed[di])
        for (const list of soulDimsFor) {
          const at = list.indexOf(di);
          if (at >= 0) list.splice(at, 1);
        }
    }

    // Optimistic talisman help, for the bound only: the best any candidate
    // could give per tree (doubled, in case Talisman Boost is up) and the most
    // slots any of them carries.
    const talBest = Object.fromEntries(dims.map(t => [t, 0]));
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
      dims.map(t => {
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

    // Group candidates that share a skill set and slot count. Same skills,
    // same slots, more points can only SHRINK what gems have to cover — so
    // within a group, if the strongest candidate still can't be filled, no
    // weaker one in that group can either. This is what turns "prove no
    // one-skill talisman works" from testing every point value on every skill
    // (dozens of fills) into testing one representative per group, which is
    // the difference between a query finishing in seconds and grinding.
    const groupOfCand = new Array(talCands.length);
    const groups = new Map();
    for (let ci = 0; ci < talCands.length; ci++) {
      const tal = talCands[ci];
      const key = tal ? tal.sk.map(([t]) => t).join(",") + "|" + tal.slots : "none";
      groupOfCand[ci] = key;
      let grp = groups.get(key);
      if (!grp) { grp = { probe: ci, probeSum: 0, members: [] }; groups.set(key, grp); }
      grp.members.push(ci);
      if (tal) {
        const sum = tal.sk.reduce((s, [, p]) => s + Math.abs(p), 0);
        if (sum > grp.probeSum) { grp.probe = ci; grp.probeSum = sum; }
      }
    }
    const groupList = [...groups.values()];

    // Suffix maxima for the branch-and-bound: from slot k onward, the most
    // points any single choice could add per tree, and the most slots.
    const order = SLOTS;
    let sufPts = [], sufSlots = [];
    // Recomputed whenever the pass swaps its candidate pools — the Soul passes
    // work from a different set of pieces, so the ceilings differ too. The
    // Soul dimensions are included: the bound has to ask how much of a Soul is
    // still reachable, not just how many skill points are.
    function buildSuffixes() {
      sufPts = []; sufSlots = [];
      sufPts[order.length] = dims.map(() => 0);
      sufSlots[order.length] = 0;
      for (let k = order.length - 1; k >= 0; k--) {
        const p = sufPts[k + 1].slice();
        let best = 0;
        const chestish = order[k] === "chest";
        for (let ti = 0; ti < dims.length; ti++) {
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
    }
    buildSuffixes();

    // ── DFS with optimistic bound ─────────────────────────────────────────
    // Everything in this loop is indexed by target-tree position and carried
    // incrementally: the bound is O(targets) per node, not O(depth × targets).
    // Indexed over `dims` (requested skills, then the Souls that can grant
    // them), so the bound can reason about both in the same pass.
    const needArr = dimNeed;
    const talBestArr = dims.map(t => talBest[t] || 0);
    const densityArr = dims.map(t => density[t] || 0);
    const results = [];
    const seen = new Set();   // armor combinations already reported
    const acc = dims.map(() => 0);
    let explored = 0, leaves = 0, truncated = false, cancelled = false, timedOut = false;
    let nodes = 0, fills = 0;   // diagnostics
    let reported = 0;           // results already streamed to the caller
    const chosen = new Array(order.length).fill(null);
    // Both are relaxed for the Soul passes below, which run on their own
    // allowance so they neither get crowded out nor slow ordinary searches.
    // Overridable so a test can prove whether these allowances, rather than
    // the algorithm, are what hides a set.
    const SOUL_EXTRA = query.soulExtra == null ? 60 : query.soulExtra;
    const SOUL_BUDGET_MS = query.soulBudgetMs == null ? 500 : query.soulBudgetMs;
    let capNow = maxResults;
    let dl = query.timeBudgetMs ? Date.now() + query.timeBudgetMs : Infinity;

    // Souls are searched for separately rather than by loosening the bound.
    //
    // Relaxing "this skill needs points" for every Soul-grantable skill meant
    // the strongest prune was off for most of the query, and cost 2.5x even on
    // searches that never involve a Deviant set. Instead the main pass keeps
    // the strict rule, and each Soul that could grant a requested skill gets
    // its own pass where that Soul is MANDATORY — which prunes hard, because
    // nearly every branch fails to reach it. Same answers, a fraction of the
    // work. `passSoulFor` is which Souls may excuse a skill from needing
    // points; `passRequire` is the Soul this pass insists on.
    let passSoulFor = trees.map(() => []);
    let passRequire = -1;

    // Is the branch chosen so far the traced set, as far as it goes?
    const onTrace = k => {
      if (!trace) return false;
      for (let i = 0; i <= k; i++)
        if (!chosen[i] || chosen[i].id !== tracedId(order[i])) return false;
      return true;
    };
    const stop = () => cancelled || timedOut || results.length >= capNow;
    const dfs = (k, accSlots) => {
      if (stop()) { truncated = truncated || results.length >= capNow; return; }
      if (k === order.length) {
        finalize();
        if (++leaves % PROGRESS_EVERY === 0) {
          // Hand over what has been found since the last report, so a long
          // search can show its work and a cancel keeps everything it reached
          // instead of throwing it away.
          if (hooks.progress) {
            hooks.progress({ explored, found: results.length, fresh: results.slice(reported) });
            reported = results.length;
          }
          if (hooks.cancelled && hooks.cancelled()) cancelled = true;
          if (Date.now() > dl) timedOut = true;
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
          // Only the requested skills are mandatory; the Soul dimensions that
          // follow them are optional routes, tested per skill below.
          const canReach = ti => {
            const have = acc[ti] + talBestArr[ti] + suf[ti];
            return have + slotsOpt * OPTIMISTIC_TORSO * densityArr[ti] + 2 >= needArr[ti];
          };
          // This pass's Soul is compulsory, so a branch that can no longer
          // reach it is finished — the prune that makes these passes cheap.
          if (passRequire >= 0 && !canReach(passRequire)) ok = false;
          for (let ti = 0; ok && ti < trees.length; ti++) {
            if (!canReach(ti)) {
              // Out of reach on its own points — but a Soul still in play would
              // hand the skill over regardless, so only give up when no
              // granting Soul can be reached either.
              if (!passSoulFor[ti].some(canReach)) { ok = false; break; }
              continue;   // a Soul may still supply it; it needs no gems
            }
            const short = needArr[ti] - (acc[ti] + talBestArr[ti] + suf[ti]);
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
        if (trace && !ok && onTrace(k)) {
          trace.notes.push(`the branch was cut at ${order[k]} (${c.a.n}): the bound judged the `
            + "remaining slots could not close the gap");
          trace.stage = trace.stage || "the branch-and-bound cut-off";
        }
        if (ok) dfs(k + 1, slotsNow);
        for (let ti = 0; ti < acc.length; ti++) acc[ti] -= c.pts[ti] * m;
        if (stop()) return;
      }
      chosen[k] = null;
    };
    // Main pass first: every requested skill earned with points. It is the
    // cheap one, and for most queries it is the whole answer.
    dfs(0, 0);

    // Then the Soul passes, each insisting on its own Soul. They get their own
    // small allowance of time and results, because otherwise they would either
    // never run (the main pass having already filled the result cap) or slow
    // every ordinary search down — and a Soul-driven set is precisely the one
    // a player is least likely to find by hand.
    const mainTimedOut = timedOut, mainTruncated = truncated;
    capNow = results.length + SOUL_EXTRA;
    dl = Math.min(dl, Date.now() + SOUL_BUDGET_MS);
    timedOut = false;
    for (let si = 0; si < soulDims.length && !stop(); si++) {
      const di = trees.length + si;
      const granted = soulDimsFor.map(list => (list.includes(di) ? [di] : []));
      if (!granted.some(l => l.length)) continue;
      passSoulFor = granted;
      passRequire = di;
      // This pass compares pieces on this Soul as well, so a Deviant piece is
      // no longer dominated by one that simply has more of the wanted skills.
      cands = buildCands(soulDims[si]);
      if (SLOTS.some(s => !cands[s].length)) continue;
      buildSuffixes();
      acc.fill(0);
      chosen.fill(null);
      dfs(0, 0);
    }
    // Whether the Soul phase got to finish is reported separately: the main
    // search can be exhaustive while the Souls were only sampled, and saying
    // "every combination was checked" would then be a lie.
    const soulTruncated = timedOut || truncated !== mainTruncated;
    timedOut = mainTimedOut;
    truncated = mainTruncated;
    passSoulFor = trees.map(() => []);
    passRequire = -1;
    passRequire = -1;

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
      // By now the armor is known, so whether a Soul is actually active can be
      // settled exactly rather than assumed: a skill it hands over needs no
      // points and no gems, and asking for them would waste slots the rest of
      // the set needs.
      //
      // A Soul pass insists on its Soul, so a skill that Soul grants is taken
      // as delivered and asks for nothing — while the Soul's OWN tree becomes
      // a requirement the gems must meet. Judging the Soul on `armorBase`
      // alone, as this did, meant a Soul bought with jewels was invisible:
      // five Yukumo Jwls activate Soul of Yukumo and hand over Honey Hunter
      // and Water Res +15, and no such set could ever be found.
      const gapOf = (t, di) => needArr[di] - ((armorBase[t] || 0) + (skillPlus2 ? 2 : 0));
      const gapArr = dims.map(() => 0);
      for (let ti = 0; ti < trees.length; ti++)
        gapArr[ti] = passSoulFor[ti].length ? 0 : gapOf(trees[ti], ti);
      if (passRequire >= 0) {
        const soulTree = dims[passRequire];
        // The Soul's tree can also be a requested skill in its own right; then
        // it is one requirement at the higher of the two thresholds, not two.
        const dup = trees.indexOf(soulTree);
        if (dup >= 0) gapArr[dup] = Math.max(gapArr[dup], gapOf(soulTree, passRequire));
        else gapArr[passRequire] = gapOf(soulTree, passRequire);
      }

      const traced = trace && onTrace(order.length - 1);
      if (traced) {
        trace.reached.leaf = true;
        trace.notes.push("the armor combination was reached; still short: "
          + (dims.map((t, i) => (gapArr[i] > 0
            ? `${(data.skills.trees || {})[t] || `tree ${t}`} by ${gapArr[i]}` : null))
            .filter(Boolean).join(", ") || "nothing"));
      }

      // Hopeless leaves are skipped without touching the fill solver: not even
      // the strongest candidate plus every slot filled with the densest gem
      // could close the gap.
      const slotCeiling = armorSlots + query.weaponSlots + talMaxSlots;
      let totalGap = 0, bestDensity = 0, shortTrees = 0;
      for (let ti = 0; ti < dims.length; ti++) {
        if (!query.noBound
          && gapArr[ti] > talBestArr[ti] + slotCeiling * (1 + torsoCount) * densityArr[ti]) {
          if (traced) {
            trace.notes.push(`no talisman and no arrangement of ${slotCeiling} slots could supply `
              + `${gapArr[ti]} more points of ${(data.skills.trees || {})[dims[ti]] || dims[ti]}`);
            trace.stage = trace.stage || "the per-skill leaf check";
          }
          return;
        }
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
      if (!query.noBound
        && totalGap > slotCeiling * (1 + torsoCount) * bestDensity + talBestSum * talMult + 2 * shortTrees) {
        if (traced) {
          trace.notes.push(`${totalGap} points are missing across ${shortTrees} skills, more than `
            + `${slotCeiling} shared slots and the best talisman could cover`);
          trace.stage = trace.stage || "the shared-slot leaf check";
        }
        return;
      }

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
      // Only skills that are actually SHORT need covering.
      const act = [];
      for (let ti = 0; ti < dims.length; ti++) if (gapArr[ti] > 0) act.push(ti);

      // What the armor and weapon slots could contribute per short skill if
      // every slot served that one skill — the ceiling a talisman has to make
      // up. Computed once so testing a candidate costs a few comparisons
      // instead of a fill; without this, a leaf with no answer pays for a fill
      // per candidate, which is where a one-skill query lost its minute.
      const baseCap = act.map(() => 0);
      for (const b of armorBins)
        for (let j = 0; j < act.length; j++) baseCap[j] += b.cap * b.mult * densityArr[act[j]];

      // fill-or-null per (residual, talisman slots) key, so repeated point
      // values that collapse to the same residual after clamping share one
      // fitGems call.
      const tried = new Map();
      function attempt(ci) {
        const tal = talCands[ci];
        const contrib = talContrib[ci];
        let possible = true;
        for (let j = 0; !query.noBound && j < act.length; j++) {
          const ti = act[j];
          if (contrib[ti] * talMult + baseCap[j] + talSlots[ci] * talMult * densityArr[ti] < gapArr[ti]) {
            possible = false; break;
          }
        }
        if (!possible) return null;
        let key = "";
        const residual = [];
        for (let j = 0; j < act.length; j++) {
          const left = gapArr[act[j]] - contrib[act[j]] * talMult;
          residual.push(left > 0 ? left : 0);
          key += (left > 0 ? left : 0) + ",";
        }
        key += "|" + talSlots[ci];
        if (tried.has(key)) return tried.get(key);
        fills++;
        const bins = tal && tal.slots
          ? armorBins.concat([{ key: "talisman", cap: tal.slots, mult: talMult }])
          : armorBins;
        const fill = (query.exactFill ? exactFit : fitGems)(residual, bins, act, jewels);
        tried.set(key, fill);
        return fill;
      }

      if (traced) trace.reached.fillAttempted = true;

      // Pass A: probe only the strongest candidate per group. A group whose
      // probe can't be filled is dead — nothing weaker in it needs testing.
      const feasible = new Set();
      for (const grp of groupList) if (attempt(grp.probe)) feasible.add(grp);

      // Pass B: within feasible groups, walk the cheapest-first order and
      // take the first that actually fills (repeats, including the probe
      // itself, are cache hits via `tried`).
      for (let ci = 0; ci < talCands.length; ci++) {
        if (!feasible.has(groups.get(groupOfCand[ci]))) continue;
        const fill = attempt(ci);
        if (!fill) continue;
        const tal = talCands[ci];
        const set = {
          pieces: Object.fromEntries(order.map(slot =>
            [slot, { id: pieces[slot].id, lv: 0, decos: fill[slot] || [] }])),
          weapon: query.weaponSlots ? { slots: query.weaponSlots, def: 0, decos: fill.weapon || [] } : null,
          talisman: tal
            ? { rar: tal.rar, slots: tal.slots, sk: tal.sk.map(e => e.slice()), decos: fill.talisman || [], gen: !!tal.gen }
            : null,
        };
        const r = g.SBEngine.compute({ weapon: set.weapon, pieces: set.pieces, talisman: set.talisman }, data);
        // What was asked for is a SKILL, and the engine is the authority on
        // whether the set has it — by points, or because a Soul granted it
        // outright. Checking points alone rejected sets that genuinely work.
        let good = !r.problems.length;
        for (const t of trees) if (!satisfied(r, t, need[t])) good = false;
        if (!good) {
          if (traced && !trace.reached.engineNote) {
            trace.reached.engineNote = true;
            trace.notes.push("a gem arrangement was found, but the engine then disagreed that the "
              + "set reaches every skill" + (r.problems.length ? `: ${r.problems[0]}` : ""));
            trace.stage = trace.stage || "the engine's own verification";
          }
          continue;   // engine disagrees with the plan: try the next talisman
        }
        const spare = Object.values(r.slots).reduce((a, s) => a + (s.total - s.used), 0);
        // The Soul passes revisit armor the main pass already cleared, so a
        // combination is only ever reported once.
        const key = order.map(s => set.pieces[s].id).join("/");
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ set, engine: r, spare, defense: r.defense, talCost: talCost(tal) });
        if (traced) { trace.reached.found = true; trace.notes.push("this armor combination IS in the results"); }
        return;
      }
    }

    results.sort((a, b) => a.talCost - b.talCost || b.spare - a.spare || b.defense - a.defense);
    if (trace && !trace.reached.found) {
      if (!trace.reached.leaf && !trace.stage) trace.stage = "the search never reached this combination";
      else if (trace.reached.fillAttempted && !trace.stage) {
        trace.stage = "the gem fill";
        trace.notes.push("no talisman in the pool, with any arrangement the fill tried, "
          + "covered what was still missing");
      }
    }
    return { results, complete: !truncated && !cancelled && !timedOut, soulTruncated, cancelled, timedOut, explored, trace, stats: { nodes, fills } };
  }

  // Fit gems into the bins to cover `residual` (indexed by position in `act`,
  // which holds the dimensions still short — requested skills and, in a Soul
  // pass, the Soul's own tree).
  //
  // This is the hot path — it runs once per armor combination per talisman, so
  // it has to cost microseconds, not milliseconds. It is a greedy fill, like
  // Athena's, run under a few different priorities: each pass places, in the
  // slots available, whichever jewel buys the most *useful* points per slot,
  // and a pass that leaves nothing outstanding wins. Trying several priorities
  // recovers most of what a single greedy pass misses; anything that still
  // slips through simply is not offered, and every set that IS offered is
  // verified by the engine afterwards, so nothing wrong is ever shown.
  const FILL_MODES = 3;
  // Exhaustive counterpart to fitGems, for testing only: tries every way of
  // packing every bin, so it finds an arrangement whenever one exists. Far
  // too slow for the live search — it is here so a differential test can say
  // whether the greedy fill is losing sets, rather than leaving that to
  // guesswork.
  function exactFit(residual, bins, act, jewels) {
    const dead = new Set();
    const place = {};
    const done = left => { for (const v of left) if (v > 0) return false; return true; };
    // Every packing of one bin, as its net effect on the requested skills.
    const loadouts = bin => {
      const out = [];
      const cur = act.map(() => 0), ids = [];
      const step = (capLeft, start) => {
        out.push({ ids: ids.slice(), eff: cur.slice() });
        for (let i = start; i < jewels.length; i++) {
          const jw = jewels[i];
          if (jw.slots > capLeft) continue;
          ids.push(jw.id);
          for (let j = 0; j < act.length; j++) cur[j] += jw.eff[act[j]] * bin.mult;
          step(capLeft - jw.slots, i);
          for (let j = 0; j < act.length; j++) cur[j] -= jw.eff[act[j]] * bin.mult;
          ids.pop();
        }
      };
      step(bin.cap, 0);
      return out;
    };
    const dfs = (i, left) => {
      if (done(left)) return true;
      if (i === bins.length) return false;
      const key = i + "|" + left.join(",");
      if (dead.has(key)) return false;
      for (const opt of loadouts(bins[i])) {
        const next = left.slice();
        for (let j = 0; j < act.length; j++) next[j] -= opt.eff[j];
        if (dfs(i + 1, next)) { if (opt.ids.length) place[bins[i].key] = opt.ids; return true; }
      }
      dead.add(key);
      return false;
    };
    return dfs(0, residual.slice()) ? place : null;
  }

  function fitGems(residual, bins, act, jewels) {
    for (let mode = 0; mode < FILL_MODES; mode++) {
      // `left` is what each requested skill is still short by, and it is NOT
      // clamped at zero: a jewel's malus can push a skill that was already
      // covered back under, and the fill has to see that happen.
      const left = residual.slice();
      const short = () => { let n = 0; for (const v of left) if (v > 0) n += v; return n; };
      let outstanding = short();
      if (!outstanding) return {};
      const placement = {};
      // mode 0: biggest bins first (keeps 3-slot jewels usable)
      // mode 1: multiplier bins first (chest/talisman points count double)
      // mode 2: smallest bins first (spends awkward single slots early)
      const order = bins.slice().sort(
        mode === 0 ? (a, b) => b.cap - a.cap || b.mult - a.mult
        : mode === 1 ? (a, b) => b.mult - a.mult || b.cap - a.cap
        : (a, b) => a.cap - b.cap || b.mult - a.mult);
      for (const bin of order) {
        let cap = bin.cap;
        while (cap > 0 && outstanding > 0) {
          let best = null, bestScore = 0;
          for (const jw of jewels) {
            if (jw.slots > cap) continue;
            // Net progress this jewel makes, counting what its malus undoes.
            let gain = 0;
            for (let j = 0; j < act.length; j++) {
              const e = jw.eff[act[j]];
              if (!e) continue;
              const v = e * bin.mult;
              const before = left[j] > 0 ? left[j] : 0;
              const after = left[j] - v > 0 ? left[j] - v : 0;
              gain += before - after;
            }
            if (gain <= 0) continue;
            const score = gain / jw.slots;
            if (score > bestScore) { bestScore = score; best = jw; }
          }
          if (!best) break;
          for (let j = 0; j < act.length; j++) left[j] -= best.eff[act[j]] * bin.mult;
          outstanding = short();
          cap -= best.slots;
          (placement[bin.key] || (placement[bin.key] = [])).push(best.id);
        }
        if (!outstanding) break;
      }
      if (!outstanding) return placement;
    }
    return null;
  }

  g.SBSearch = { search, generateTalismans, talCost };
})(typeof window !== "undefined" ? window : globalThis);
