// engine.js — pure set computation. No DOM, no globals beyond the SBEngine
// export; loadable in Node (scripts/test-engine.mjs) and in the page.
(function (g) {
  "use strict";

  const TORSO_UP = 203;       // skill-tree id of the Torso Up marker skill
  const SECRET_ARTS = 204;    // "Skill +2" at 10: +2 to every tree with points invested
  const TALISMAN_BOOST = 205; // "Double Talisman" at 10: talisman skills and decos count twice

  // build = {
  //   weapon:   { slots, def, decos: [itemId...] } | null   (already resolved to
  //             the chosen level's numbers — the engine never fetches),
  //   pieces:   { head|chest|arms|waist|legs: { id, lv, decos: [...] } | null },
  //   talisman: { slots, sk: [[treeId, pts], ...up to 2], decos: [...] } | null,
  // }
  // data = { armor: SB_ARMOR, decos: SB_DECOS, skills: SB_SKILLS, souls: SB_SOULS }
  const SLOTS = ["head", "chest", "arms", "waist", "legs"];

  function decoSk(ids, data) {
    const out = [];
    for (const id of ids || []) {
      const d = data.decos[id];
      if (d) out.push(...d.sk);
    }
    return out;
  }
  function decoCost(ids, data) {
    let n = 0;
    for (const id of ids || []) n += data.decos[id] ? data.decos[id].slots : 0;
    return n;
  }

  function compute(build, data) {
    const problems = [];
    const treePoints = {};
    const add = (tree, pts, mult) => { treePoints[tree] = (treePoints[tree] || 0) + pts * (mult || 1); };

    // Torso Up: each equipped piece carrying tree 203 multiplies the CHEST's
    // skill points — the piece's own and its socketed decorations' alike.
    let torsoUpCount = 0;
    for (const slot of SLOTS) {
      const p = build.pieces[slot];
      if (!p) continue;
      const a = data.armor[slot][p.id];
      if (a && a.sk.some(([t]) => t === TORSO_UP)) torsoUpCount++;
    }
    const chestMult = 1 + torsoUpCount;

    let defense = 0, defenseMax = 0;
    const res = [0, 0, 0, 0, 0];
    const slotUse = {};

    for (const slot of SLOTS) {
      const p = build.pieces[slot];
      if (!p) continue;
      const a = data.armor[slot][p.id];
      if (!a) { problems.push(`Unknown ${slot} piece id ${p.id}.`); continue; }
      const mult = slot === "chest" ? chestMult : 1;
      for (const [tree, pts] of a.sk) if (tree !== TORSO_UP) add(tree, pts, mult);
      for (const [tree, pts] of decoSk(p.decos, data)) add(tree, pts, mult);
      const effMax = Math.min(a.maxLv || a.lv.length, a.lv.length);
      const lv = Math.min(Math.max(p.lv || effMax, 1), effMax);
      defense += a.lv[lv - 1];
      defenseMax += a.lv[effMax - 1];
      for (let i = 0; i < 5; i++) res[i] += a.res[i];
      slotUse[slot] = { used: decoCost(p.decos, data), total: a.slots };
    }

    if (build.weapon) {
      defense += build.weapon.def || 0;
      defenseMax += build.weapon.def || 0;
      for (const [tree, pts] of decoSk(build.weapon.decos, data)) add(tree, pts);
      slotUse.weapon = { used: decoCost(build.weapon.decos, data), total: build.weapon.slots || 0 };
    }
    // Talisman contributions are tracked separately so Double Talisman can
    // count them a second time.
    const talPoints = {};
    if (build.talisman) {
      const addTal = (tree, pts) => { add(tree, pts); talPoints[tree] = (talPoints[tree] || 0) + pts; };
      for (const [tree, pts] of build.talisman.sk || []) addTal(tree, pts);
      for (const [tree, pts] of decoSk(build.talisman.decos, data)) addTal(tree, pts);
      slotUse.talisman = { used: decoCost(build.talisman.decos, data), total: build.talisman.slots || 0 };
    }

    for (const [what, u] of Object.entries(slotUse))
      if (u.used > u.total) problems.push(`${what}: ${u.used} slot(s) of decorations in ${u.total}.`);

    // Secret Arts, then Talisman Boost — in that order, because the game's own
    // Neset set sums Secret Arts 10 / Talisman Boost 8 and relies on the +2 to
    // push Talisman Boost over its threshold (Athena's ASS models the same by
    // force-enabling both on a full Neset set). The +2 goes to every tree with
    // a nonzero total, negatives included, matching ASS AddAllSkillsPlus2().
    const posThreshold = tree => {
      const ladder = data.skills.active[tree];
      const step = ladder && ladder.find(s => s[0] > 0);
      return step ? step[0] : Infinity;
    };
    const skillPlus2 = (treePoints[SECRET_ARTS] || 0) >= posThreshold(SECRET_ARTS);
    if (skillPlus2)
      for (const k of Object.keys(treePoints)) if (treePoints[k] !== 0) treePoints[k] += 2;
    const talismanDoubled = (treePoints[TALISMAN_BOOST] || 0) >= posThreshold(TALISMAN_BOOST);
    if (talismanDoubled)
      for (const [k, pts] of Object.entries(talPoints)) treePoints[k] = (treePoints[k] || 0) + pts;

    // Activation: per tree, the highest positive threshold reached, and the
    // deepest negative threshold reached. (A tree can't hold both — points are
    // one number — but the walk is generic either way.)
    const active = [];
    for (const [treeStr, pts] of Object.entries(treePoints)) {
      const tree = Number(treeStr);
      const ladder = data.skills.active[tree];
      if (!ladder) continue;
      let hit = null;
      if (pts > 0) for (const step of ladder) { if (step[0] > 0 && pts >= step[0]) hit = step; }
      else if (pts < 0) for (const step of ladder) { if (step[0] < 0 && pts <= step[0]) { hit = step; break; } }
      if (hit) active.push({ tree, threshold: hit[0], name: hit[1], desc: hit[2], negative: hit[0] < 0 });
    }
    active.sort((a, b) => (a.negative - b.negative) || (b.threshold - a.threshold));

    // Soul expansion: an activated compound skill stands for its granted
    // skills. A grant whose tree+threshold already activated naturally is
    // skipped — it is already in the list.
    const soulGrants = [];
    const granted = new Set(active.map(x => `${x.tree}:${x.threshold}`));
    for (const a of active) {
      const grants = data.souls[a.tree] && data.souls[a.tree][a.threshold];
      if (!grants) continue;
      a.soul = true;
      for (const [gTree, gPts] of grants) {
        const key = `${gTree}:${gPts}`;
        if (granted.has(key)) continue;   // already active, or granted by another soul
        granted.add(key);
        const step = (data.skills.active[gTree] || []).find(s => s[0] === gPts);
        if (!step) continue;
        soulGrants.push({ tree: gTree, threshold: gPts, name: step[1], desc: step[2], negative: gPts < 0, fromSoul: a.tree });
      }
    }

    return {
      defense, defenseMax, res, slots: slotUse,
      treePoints, torsoUpCount, skillPlus2, talismanDoubled,
      active, soulGrants, problems,
    };
  }

  // A talisman's equip id IS its rarity (1-10); each maps to one of four roll
  // tiers whose table bounds the legal skills and points. Same convention as
  // the save editor and the Equipment Box.
  const TAL_TIER = [null, "mystery", "mystery", "shining", "shining",
    "timeworn", "timeworn", "timeworn", "enduring", "enduring", "enduring"];

  // Talisman entry validation. tal = { rar: 1-10, slots, sk: [[treeId, pts], ...] }
  // — returns problem strings; empty means legal.
  function validateTalisman(tal, charm, skills) {
    const problems = [];
    if (!Number.isInteger(tal.rar) || tal.rar < 1 || tal.rar > 10)
      return ["Talisman rarity must be 1-10."];
    const table = charm.tiers[TAL_TIER[tal.rar]];
    if (!table) return [`No roll table for rarity ${tal.rar}.`];
    if (!Number.isInteger(tal.slots) || tal.slots < 0 || tal.slots > 3)
      problems.push("Slots must be 0-3.");
    const sk = tal.sk || [];
    if (sk.length < 1) problems.push("A talisman always has a first skill.");
    if (sk.length > 2) problems.push("A talisman has at most two skills.");
    const name = t => (skills && skills.trees[t]) || `tree ${t}`;
    if (sk[0]) {
      const [tree, pts] = sk[0];
      const row = table[tree];
      if (!row || (row[0] === 0 && row[1] === 0))
        problems.push(`${name(tree)} can't roll as the first skill on this tier.`);
      else if (pts < row[0] || pts > row[1])
        problems.push(`${name(tree)} rolls ${row[0]} to ${row[1]} as the first skill on this tier.`);
    }
    if (sk[1]) {
      const [tree, pts] = sk[1];
      if (sk[0] && tree === sk[0][0]) problems.push("The two skills must differ.");
      const row = table[tree];
      if (!row || (row[2] === 0 && row[3] === 0))
        problems.push(`${name(tree)} can't roll as the second skill on this tier.`);
      else if (pts < row[2] || pts > row[3])
        problems.push(`${name(tree)} rolls ${row[2]} to ${row[3]} as the second skill on this tier.`);
    }
    return problems;
  }

  g.SBEngine = { compute, validateTalisman, decoCost, TORSO_UP, TAL_TIER };
})(typeof window !== "undefined" ? window : globalThis);
