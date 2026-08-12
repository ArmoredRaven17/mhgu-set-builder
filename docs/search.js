/* search.js — the simplified set search. Pure: no DOM, Node-loadable.
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
 * bins are the seven slot-bearing positions, gems are the best jewel per
 * (tree, size), and a memoized DFS either proves the deficit fillable or not.
 */
(function (g) {
  "use strict";
  const SLOTS = ["head", "chest", "arms", "waist", "legs"];
  const TORSO_UP = 203, SECRET_ARTS = 204, TALISMAN_BOOST = 205;
  const OPTIMISTIC_TORSO = 5;   // bound-only chest multiplier (1 + up to 4 pieces)

  // query = {
  //   targets: [[treeId, points], ...],       activation thresholds to reach
  //   gender: 0|1,                            0 male, 1 female
  //   cls: "B"|"G",
  //   maxRar: 1..11,
  //   weaponSlots: 0..3,
  //   talisman: { slots, sk: [[tree,pts],...] } | null,   the user's real talisman
  //   maxResults: cap (default 50)
  // }
  function search(query, data) {
    const need = {};
    for (const [t, p] of query.targets) need[t] = Math.max(need[t] || 0, p);
    const trees = Object.keys(need).map(Number);
    const maxResults = query.maxResults || 50;
    if (!trees.length) return { results: [], complete: true, explored: 0 };

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

    // Suffix maxima for the branch-and-bound: from slot k onward, the most
    // points any single choice could add per tree, and the most slots.
    const order = SLOTS;
    const sufPts = [], sufSlots = [];
    let accP = Object.fromEntries(trees.map(t => [t, 0])), accS = 0;
    sufPts[order.length] = { ...accP }; sufSlots[order.length] = 0;
    for (let k = order.length - 1; k >= 0; k--) {
      const p = { ...sufPts[k + 1] };
      let s = sufSlots[k + 1], best = 0;
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
      sufPts[k] = p; sufSlots[k] = s + best;
      void accP; void accS;
    }

    // Talisman base contribution (doubling handled at finalize).
    const talBase = Object.fromEntries(trees.map(t => [t, 0]));
    if (query.talisman) for (const [t, p] of query.talisman.sk) if (t in talBase) talBase[t] += p;

    // ── DFS with optimistic bound ─────────────────────────────────────────
    const results = [];
    let explored = 0, truncated = false;
    const chosen = new Array(order.length).fill(null);

    const dfs = k => {
      if (results.length >= maxResults) { truncated = true; return; }
      if (k === order.length) { finalize(); return; }
      for (const c of cands[order[k]]) {
        chosen[k] = c;
        // Optimistic bound: current picks (chest ×5) + best future per tree
        // + every reachable slot filled with the densest gem + the +2.
        // query.noBound disables it — test-only, to prove the bound never
        // prunes a feasible set.
        let ok = true;
        if (query.noBound) { dfs(k + 1); if (results.length >= maxResults) { truncated = true; return; } continue; }
        let slotsNow = query.weaponSlots + (query.talisman ? query.talisman.slots : 0);
        for (let i = 0; i <= k; i++) slotsNow += chosen[i].a.slots;
        const slotsOpt = slotsNow + sufSlots[k + 1];
        for (const t of trees) {
          let have = talBase[t];
          for (let i = 0; i <= k; i++) {
            const sk = chosen[i].a.sk.find(([tr]) => tr === t);
            if (!sk) continue;
            let pts = sk[1];
            if (order[i] === "chest") pts *= OPTIMISTIC_TORSO;
            have += pts;
          }
          if (have + sufPts[k + 1][t] + slotsOpt * OPTIMISTIC_TORSO * density[t] + 2 < need[t]) { ok = false; break; }
        }
        if (ok) dfs(k + 1);
        if (results.length >= maxResults) { truncated = true; return; }
      }
      chosen[k] = null;
    };
    dfs(0);

    // ── Finalize: exact sums, cascade flags, exact gem fill, engine check ─
    function finalize() {
      explored++;
      const pieces = {};
      order.forEach((slot, i) => { pieces[slot] = chosen[i]; });
      const torsoCount = order.reduce((n, slot, i) =>
        n + (chosen[i].a.sk.some(([tr]) => tr === TORSO_UP) ? 1 : 0), 0);
      const mult = 1 + torsoCount;

      // Exact base points for every tree the armor or talisman touches
      // (204/205 exist only on armor, so the cascade flags are exact here).
      const base = {};
      const addB = (t, p) => { base[t] = (base[t] || 0) + p; };
      order.forEach((slot, i) => {
        for (const [tr, p] of chosen[i].a.sk)
          if (tr !== TORSO_UP) addB(tr, slot === "chest" ? p * mult : p);
      });
      if (query.talisman) for (const [t, p] of query.talisman.sk) addB(t, p);
      const skillPlus2 = (base[SECRET_ARTS] || 0) >= 10;
      const talDoubled = ((base[TALISMAN_BOOST] || 0) + (skillPlus2 && base[TALISMAN_BOOST] ? 2 : 0)) >= 10;
      if (talDoubled && query.talisman)
        for (const [t, p] of query.talisman.sk) addB(t, p);

      // Deficits after the +2 (thresholds are all >= 10, so a zero-point tree
      // still genuinely needs gems).
      const deficit = {};
      for (const t of trees) {
        const have = (base[t] || 0) + (skillPlus2 ? 2 : 0);
        if (have < need[t]) deficit[t] = need[t] - have;
      }

      // Bins, multiplied ones first so the fill favors them.
      const bins = [];
      if (pieces.chest.a.slots) bins.push({ key: "chest", cap: pieces.chest.a.slots, mult });
      if (query.talisman && query.talisman.slots) bins.push({ key: "talisman", cap: query.talisman.slots, mult: talDoubled ? 2 : 1 });
      for (const slot of ["head", "arms", "waist", "legs"])
        if (pieces[slot].a.slots) bins.push({ key: slot, cap: pieces[slot].a.slots, mult: 1 });
      if (query.weaponSlots) bins.push({ key: "weapon", cap: query.weaponSlots, mult: 1 });
      bins.sort((a, b) => b.mult - a.mult || b.cap - a.cap);

      const fill = exactFill(deficit, bins, gems);
      if (!fill) return;

      // Materialize and let the engine be the judge.
      const set = {
        pieces: Object.fromEntries(order.map(slot => {
          const decos = (fill[slot] || []);
          return [slot, { id: pieces[slot].id, lv: 0, decos }];
        })),
        weapon: query.weaponSlots ? { slots: query.weaponSlots, def: 0, decos: fill.weapon || [] } : null,
        talisman: query.talisman
          ? { rar: query.talisman.rar, slots: query.talisman.slots, sk: query.talisman.sk, decos: fill.talisman || [] }
          : null,
      };
      const r = g.SBEngine.compute({ weapon: set.weapon, pieces: set.pieces, talisman: set.talisman }, data);
      for (const t of trees) if ((r.treePoints[t] || 0) < need[t]) return;   // engine disagrees: drop
      if (r.problems.length) return;
      const spare = Object.values(r.slots).reduce((a, s) => a + (s.total - s.used), 0);
      results.push({ set, engine: r, spare, defense: r.defense });
    }

    results.sort((a, b) => b.spare - a.spare || b.defense - a.defense);
    return { results, complete: !truncated, explored };
  }

  // Exact decoration fill: can `deficit` be covered by jewels in `bins`?
  // Bins are few (<= 7) and caps tiny (<= 3), so a memoized DFS over
  // (bin index, remaining deficit) is exact and instant. Returns
  // { binKey: [decoId, ...] } or null.
  function exactFill(deficit, bins, gems) {
    const trees = Object.keys(deficit).map(Number);
    if (!trees.length) return {};
    const dead = new Set();   // memoized infeasible states
    const stateKey = (i, d) => i + "|" + trees.map(t => Math.max(0, d[t])).join(",");

    // Per-bin loadout options: all ways to pack gems for the target trees
    // into `cap` slots. Generated per call — bins differ only by cap/mult.
    function loadouts(cap, mult) {
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
      return out;
    }

    const placement = {};
    const dfs = (i, d) => {
      if (trees.every(t => d[t] <= 0)) return true;
      if (i === bins.length) return false;
      const key = stateKey(i, d);
      if (dead.has(key)) return false;
      const bin = bins[i];
      // Try fuller loadouts first — multiplied bins are ordered first, so
      // spending them greedily is the efficient direction.
      const opts = loadouts(bin.cap, bin.mult)
        .sort((a, b) => Object.values(b.pts).reduce((x, y) => x + y, 0) - Object.values(a.pts).reduce((x, y) => x + y, 0));
      for (const opt of opts) {
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

  g.SBSearch = { search };
})(typeof window !== "undefined" ? window : globalThis);
