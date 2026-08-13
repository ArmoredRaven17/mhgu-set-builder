// test-search.mjs — search over the real generated data.  Run:  node scripts/test-search.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = f => {
  const s = readFileSync(join(ROOT, "docs", "data", f), "utf8");
  return JSON.parse(s.slice(s.indexOf("=") + 1).replace(/;\s*\n?$/, ""));
};
await import(`file://${join(ROOT, "docs", "engine.js").replace(/\\/g, "/")}`);
await import(`file://${join(ROOT, "docs", "search.js").replace(/\\/g, "/")}`);
const E = globalThis.SBEngine, S = globalThis.SBSearch;

const data = {
  skills: load("skills.js"), souls: load("souls.js"),
  decos: load("decos.js"), armor: load("armor.js"),
};
const treeId = name => Number(Object.entries(data.skills.trees).find(([, n]) => n === name)[0]);

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`);
  else { console.error(`  FAIL ${msg}`); failed++; }
};
// A set HAS a skill if it has the points, or if a Soul granted the skill
// outright — the full Redhelm set activates Focus with no Focus points.
const hasSkill = (r, t, p) => (r.treePoints[t] || 0) >= p
  || r.active.some(a => a.tree === t && !a.negative && a.threshold >= p)
  || r.soulGrants.some(gr => gr.tree === t && !gr.negative && gr.threshold >= p);
const verifyAll = (res, targets) => res.results.every(({ set }) => {
  const r = E.compute({ weapon: set.weapon, pieces: set.pieces, talisman: set.talisman }, data);
  return targets.every(([t, p]) => hasSkill(r, t, p)) && r.problems.length === 0;
});
const genderOk = (res, gender) => res.results.every(({ set }) =>
  Object.entries(set.pieces).every(([slot, p]) => {
    const a = data.armor[slot][p.id];
    return a.gender === 2 || a.gender === gender;
  }));

console.log("single target: Attack Up (M), male blademaster:");
{
  const targets = [[treeId("Attack"), 15]];
  const t0 = Date.now();
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, talismans: [], maxResults: 50 }, data);
  console.log(`  (${Date.now() - t0} ms, ${res.explored} finalized, ${res.results.length} results)`);
  check(res.results.length > 0, "finds sets");
  check(verifyAll(res, targets), "every result re-verifies through the engine");
  check(genderOk(res, 0), "no female-only pieces");
  check(res.results.every(({ set }) =>
    Object.entries(set.pieces).every(([slot, p]) => {
      const a = data.armor[slot][p.id];
      return a.cls === "A" || a.cls === "B";
    })), "no gunner-only pieces");
}

console.log("double target: Earplugs + Attack Up (S), with a real talisman:");
{
  const targets = [[treeId("Hearing"), 10], [treeId("Attack"), 10]];
  const tal = { rar: 7, slots: 3, sk: [[treeId("Attack"), 5]] };
  const t0 = Date.now();
  const res = S.search({ targets, gender: 1, cls: "G", maxRar: 11, weaponSlots: 0, talismans: [tal], allowNoTalisman: false, maxResults: 50 }, data);
  console.log(`  (${Date.now() - t0} ms, ${res.explored} finalized, ${res.results.length} results)`);
  check(res.results.length > 0, "finds sets");
  check(verifyAll(res, targets), "every result re-verifies through the engine");
  check(genderOk(res, 1), "no male-only pieces");
}

console.log("triple target, tight: HG Earplugs + Attack Up (L) + Weakness Exploit:");
{
  const targets = [[treeId("Hearing"), 15], [treeId("Attack"), 20], [treeId("Tenderizer"), 10]];
  const t0 = Date.now();
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, talismans: [{ rar: 10, slots: 0, sk: [[treeId("Attack"), 10]] }], maxResults: 30 }, data);
  console.log(`  (${Date.now() - t0} ms, ${res.explored} finalized, ${res.results.length} results)`);
  check(res.results.length > 0, "finds sets (this combo is known possible in MHGU)");
  check(verifyAll(res, targets), "every result re-verifies through the engine");
}

console.log("impossible: Skill +2 without Neset-tier rarity:");
{
  const targets = [[treeId("Secret Arts"), 10]];
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 5, weaponSlots: 3, talismans: [], maxResults: 10 }, data);
  check(res.results.length === 0 && res.complete, "no results, search terminates");
}

console.log("neset cascade found by search: Skill +2 + Double Talisman:");
{
  const targets = [[treeId("Secret Arts"), 10], [treeId("Talisman Boost"), 10]];
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 0, talismans: [], maxResults: 10 }, data);
  check(res.results.length > 0, "full Neset emerges from the search");
  check(res.results.every(({ engine }) => engine.skillPlus2 && engine.talismanDoubled),
    "results activate both via the cascade");
}

console.log("bound soundness: pruned search equals unbounded search on a small space:");
{
  // Rarity cap 3 keeps the candidate pool small enough to enumerate fully.
  // noBound disables the branch-and-bound but shares every other code path,
  // so any difference in the result sets is the bound wrongly pruning.
  const targets = [[treeId("Attack"), 10], [treeId("Hearing"), 10]];
  const q = { targets, gender: 0, cls: "B", maxRar: 3, weaponSlots: 3, talismans: [], maxResults: 100000 };
  const key = ({ set }) => ["head", "chest", "arms", "waist", "legs"].map(s => set.pieces[s].id).join("/");
  const t0 = Date.now();
  const pruned = S.search(q, data);
  const naive = S.search({ ...q, noBound: true }, data);
  console.log(`  (${Date.now() - t0} ms total; pruned finalized ${pruned.explored} vs naive ${naive.explored}; results ${pruned.results.length} vs ${naive.results.length})`);
  check(pruned.complete && naive.complete, "both runs complete");
  const pk = new Set(pruned.results.map(key)), nk = new Set(naive.results.map(key));
  check(pk.size === pruned.results.length, "no duplicate sets in results");
  check(nk.size === pk.size && [...nk].every(k => pk.has(k)), "identical result sets with and without the bound");
  check(pruned.explored <= naive.explored, "the bound reduces work");
}

console.log("generated talisman candidates:");
{
  const charm = load("charm.js");
  const atk = treeId("Attack"), hear = treeId("Hearing");
  const one = S.generateTalismans([atk, hear], charm, { maxRar: 10, twoSkill: false });
  const two = S.generateTalismans([atk, hear], charm, { maxRar: 10, twoSkill: true });
  check(one.every(t => t.sk.length === 1), "one-skill mode yields only single-skill talismans");
  check(two.some(t => t.sk.length === 2), "two-skill mode yields paired talismans");
  check(one.every(t => t.slots >= 0 && t.slots <= 3), "slot counts stay legal");
  check(one.every(t => E.validateTalisman(t, charm, data.skills).length === 0),
    "every generated one-skill talisman passes the engine's legality check");
  check(two.every(t => E.validateTalisman(t, charm, data.skills).length === 0),
    "every generated two-skill talisman passes the engine's legality check");
  // The tiers roll different skills in each position, so the sweep must cover
  // every rarity up to the cap: Attack rolls as a Pawn's FIRST skill but on a
  // Creator only as a second one, so a one-skill Attack talisman exists only
  // at low rarity. Generating at the cap alone would lose it.
  const top = charm.tiers[E.TAL_TIER[10]];
  check(!top[atk] || (top[atk][0] === 0 && top[atk][1] === 0),
    "Attack indeed cannot be a Creator talisman's first skill (data check)");
  const oneAtk = S.generateTalismans([atk], charm, { twoSkill: false });
  check(oneAtk.some(t => t.sk[0][0] === atk), "the tier sweep still offers a one-skill Attack talisman");
  check(oneAtk.every(t => E.validateTalisman(t, charm, data.skills).length === 0),
    "and each is legal at the rarity it is attributed to");
  // Points and slots drive everything: the ladder must be complete, so the
  // search can report the smallest talisman that works rather than the biggest.
  const atkPts = [...new Set(oneAtk.filter(t => t.sk[0][0] === atk).map(t => t.sk[0][1]))].sort((a, b) => a - b);
  check(atkPts.length > 1 && atkPts[0] === 1, `every point value is offered, not just the maximum (${atkPts.join(",")})`);
  // Slot counts are NOT free of the tier that rolled them: two slots never come
  // from a mystery talisman, three never from mystery or shining. This asserted
  // "0,1,2,3 at every point value" until Athena's CharmDatabase::CharmIsLegal
  // showed that was inventing charms — a 3-slot Pawn Talisman among them.
  const atkSlots = oneAtk.filter(t => t.sk[0][0] === atk && t.sk[0][1] === atkPts[0]);
  check(atkSlots.every(t => E.TIER_ORDER.indexOf(E.TAL_TIER[t.rar]) >= E.SLOT_TIER_FLOOR[t.slots]),
    "no talisman is attributed to a tier that cannot roll that many slots");
  // Attack is the awkward case on purpose: it only rolls as a FIRST skill on
  // the low tiers, and those cannot produce three slots — so a 3-slot Attack
  // talisman correctly does not exist. The floor is checked on a wider pool.
  check(Math.max(...atkSlots.map(t => t.slots)) <= 2,
    `a one-skill Attack talisman tops out at 2 slots (offered: ${[...new Set(atkSlots.map(t => t.slots))].sort().join(",")})`);
  const wide = S.generateTalismans([treeId("Expert"), treeId("Tenderizer"), treeId("Critical Up")],
    charm, { twoSkill: false });
  const threeSlot = wide.filter(t => t.slots === 3);
  check(threeSlot.length > 0 && threeSlot.every(t => t.rar >= 5),
    "and where 3 slots ARE offered, never below Timeworn (rarity 5)");
  check(oneAtk.every(t => t.rar >= 1 && t.rar <= 10), "each candidate carries the rarity that can roll it");
  // Only requested trees appear.
  check(one.every(t => t.sk.every(([tr]) => tr === atk || tr === hear)), "only targeted skills are generated");
}

console.log("search with generated talismans (Any mode):");
{
  const charm = load("charm.js");
  const targets = [[treeId("Hearing"), 15], [treeId("Attack"), 20], [treeId("Tenderizer"), 10]];
  const talismans = S.generateTalismans(targets.map(t => t[0]), charm, { maxRar: 10, twoSkill: false });
  const t0 = Date.now();
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, talismans, maxResults: 30 }, data);
  console.log(`  (${Date.now() - t0} ms, ${res.results.length} results, ${talismans.length} candidates)`);
  check(res.results.length > 0, "finds sets using a generated talisman");
  check(verifyAll(res, targets), "every result re-verifies through the engine");
  check(res.results.every(({ set }) => !set.talisman || E.validateTalisman(set.talisman, charm, data.skills).length === 0),
    "the talisman each result asks for is actually obtainable");
  check(res.results.every((r, i, arr) => i === 0 || arr[i - 1].talCost <= r.talCost),
    "results are ordered by how modest the talisman is");
}

console.log("progress and cancellation hooks:");
{
  const targets = [[treeId("Attack"), 10]];
  let ticks = 0;
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 0, talismans: [], maxResults: 100000 },
    data, { progress: () => { ticks++; }, cancelled: () => ticks >= 2 });
  check(ticks > 0, "progress hook fires during a long search");
  check(res.cancelled === true && res.complete === false, "cancellation stops the search and is reported");
}

// Independent validation: rebuild each result from nothing but its ids and
// check it against the game's rules, rather than trusting what the search
// reported about itself.
function validateResult(r, targets, query, charm) {
  const problems = [];
  const SLOTS5 = ["head", "chest", "arms", "waist", "legs"];
  const rebuilt = {
    weapon: r.set.weapon ? { slots: r.set.weapon.slots, def: r.set.weapon.def || 0, decos: r.set.weapon.decos.slice() } : null,
    pieces: {}, talisman: null,
  };
  for (const slot of SLOTS5) {
    const p = r.set.pieces[slot];
    if (!p) { problems.push(`${slot} empty`); continue; }
    const a = data.armor[slot][p.id];
    if (!a) { problems.push(`${slot} id ${p.id} not in the armor tables`); continue; }
    if (a.gender !== 2 && a.gender !== query.gender) problems.push(`${slot} ${a.n} is the wrong gender`);
    if (a.cls !== "A" && a.cls !== query.cls) problems.push(`${slot} ${a.n} is the wrong class`);
    if (a.rar > query.maxRar) problems.push(`${slot} ${a.n} exceeds the rarity cap`);
    // Decorations must exist and fit the piece's own slots.
    let used = 0;
    for (const id of p.decos) {
      const d = data.decos[id];
      if (!d) { problems.push(`${slot} has decoration ${id} which does not exist`); continue; }
      used += d.slots;
    }
    if (used > a.slots) problems.push(`${slot} ${a.n} holds ${used} slots of gems in ${a.slots}`);
    rebuilt.pieces[slot] = { id: p.id, lv: 0, decos: p.decos.slice() };
  }
  if (r.set.talisman) {
    const t = r.set.talisman;
    const legal = E.validateTalisman(t, charm, data.skills);
    if (legal.length) problems.push(`talisman is not obtainable: ${legal.join("; ")}`);
    let used = 0;
    for (const id of t.decos) { const d = data.decos[id]; if (d) used += d.slots; else problems.push(`talisman gem ${id} missing`); }
    if (used > t.slots) problems.push(`talisman holds ${used} slots of gems in ${t.slots}`);
    rebuilt.talisman = { slots: t.slots, sk: t.sk.map(e => e.slice()), decos: t.decos.slice() };
  }
  if (rebuilt.weapon) {
    let used = 0;
    for (const id of rebuilt.weapon.decos) { const d = data.decos[id]; if (d) used += d.slots; }
    if (used > rebuilt.weapon.slots) problems.push(`weapon holds ${used} slots of gems in ${rebuilt.weapon.slots}`);
  }
  // Finally: does it actually activate what was asked for?
  const eng = E.compute(rebuilt, data);
  for (const [t, p] of targets)
    if (!hasSkill(eng, t, p))
      problems.push(`${data.skills.trees[t]} reaches ${eng.treePoints[t] || 0}, needed ${p}`);
  for (const pr of eng.problems) problems.push(`engine: ${pr}`);
  return problems;
}

console.log("independent validation of every returned set:");
{
  const charm = load("charm.js");
  const cases = [
    { name: "3 skills, blademaster, 3 weapon slots",
      targets: [[treeId("Hearing"), 15], [treeId("Attack"), 20], [treeId("Tenderizer"), 10]],
      gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, twoSkill: false },
    // The exact five-skill gunner query reported as taking too long: TrueShot
    // Up, Weakness Exploit, Critical Boost, Challenger +2, Heavy/Heavy Up.
    { name: "5 skills, gunner, no weapon slots (reported case)",
      targets: [[treeId("Haphazard"), 10], [treeId("Tenderizer"), 10], [treeId("Critical Up"), 10],
                [treeId("Spirit"), 15], [treeId("Heavy Up"), 10]],
      gender: 0, cls: "G", maxRar: 11, weaponSlots: 0, twoSkill: true, budgetMs: 3000 },
    // The same query with only one-skill talismans allowed: no answer exists
    // (only two-skill talismans reach it), so this exercises proving a NEGATIVE
    // fast rather than grinding — the failure mode from the bug report.
    { name: "5 skills, gunner, one-skill only (no answer exists)",
      targets: [[treeId("Haphazard"), 10], [treeId("Tenderizer"), 10], [treeId("Critical Up"), 10],
                [treeId("Spirit"), 15], [treeId("Heavy Up"), 10]],
      // Proving a negative also has to rule out every Soul that could grant one
      // of these skills, which is a little extra work for a lot of correctness.
      gender: 0, cls: "G", maxRar: 11, weaponSlots: 0, twoSkill: false, expectEmpty: true, budgetMs: 25000 },
    { name: "6 skills, blademaster (no cap on how many)",
      targets: [[treeId("Hearing"), 10], [treeId("Attack"), 10], [treeId("Tenderizer"), 10],
                [treeId("Sharpness"), 10], [treeId("Critical Up"), 10], [treeId("Spirit"), 10]],
      gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, twoSkill: true, budgetMs: 3000 },
  ];
  for (const c of cases) {
    const talismans = S.generateTalismans(c.targets.map(t => t[0]), charm, { twoSkill: c.twoSkill });
    const q = { targets: c.targets, gender: c.gender, cls: c.cls, maxRar: c.maxRar,
      weaponSlots: c.weaponSlots, talismans, maxResults: 30, timeBudgetMs: 30000 };
    const t0 = Date.now();
    const res = S.search(q, data);
    const ms = Date.now() - t0;
    const bad = [];
    for (const r of res.results) {
      const probs = validateResult(r, c.targets, q, charm);
      if (probs.length) bad.push(`${probs.join(" | ")}`);
    }
    console.log(`  ${c.name}: ${res.results.length} sets, ${ms} ms`);
    if (c.expectEmpty) check(res.results.length === 0 && res.complete, `  correctly proves no set exists (${c.name})`);
    else check(res.results.length > 0, `  finds sets (${c.name})`);
    check(bad.length === 0, `  every set is valid${bad.length ? " — " + bad[0] : ""}`);
    if (c.budgetMs) check(ms < c.budgetMs, `  finishes within ${c.budgetMs} ms (took ${ms} ms)`);
  }
}

console.log("weapon slots sweep — a set can hinge entirely on them:");
{
  const charm = load("charm.js");
  // The Black X set: Sheath Control has no jewel and one piece per slot
  // carries it, so the armor is forced and brings just 2 slots. Whether the
  // set is possible at all comes down to how many the weapon adds.
  const targets = ["Focus", "Critical Boost", "Critical Draw", "Sheath Control",
    "Blightproof", "Challenge Sheath"].map(n => {
    for (const [t, ladder] of Object.entries(data.skills.active))
      for (const [pts, nm] of ladder) if (nm === n) return [Number(t), pts];
    throw new Error("no skill " + n);
  });
  const talismans = S.generateTalismans(targets.map(t => t[0]), charm, { twoSkill: false });
  const counts = [];
  for (let ws = 0; ws <= 3; ws++) {
    const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: ws,
      talismans, maxResults: 50, timeBudgetMs: 60000 }, data);
    counts.push(res.results.length);
    check(verifyAll(res, targets), `  ${ws} weapon slots: ${res.results.length} set(s), all valid`);
  }
  console.log(`  sets by weapon slots 0..3: ${counts.join(", ")}`);
  // Slots can only ever help. If a wider weapon found FEWER sets, something is
  // pruning wrongly — this is the invariant that would have caught testing at
  // one slot count and generalising from it.
  check(counts.every((n, i) => i === 0 || n >= counts[i - 1]),
    "more weapon slots never finds fewer sets");
  check(counts[3] > 0, "this set is reachable once the weapon has 3 slots");
  check(counts[0] === 0, "and genuinely out of reach with a slotless weapon");
}

console.log("skills granted by a Soul, not by points:");
{
  // The full Redhelm set activates Focus and Resentment through Redhelm Soul
  // while carrying zero points in either. The search used to be blind to this
  // three times over: the pieces looked irrelevant, any that survived were
  // pruned as dominated, and the final check only ever counted points.
  const skillTarget = name => {
    for (const [t, ladder] of Object.entries(data.skills.active))
      for (const [pts, nm] of ladder) if (nm === name) return [Number(t), pts];
    throw new Error("no skill " + name);
  };
  const focus = skillTarget("Focus"), resent = skillTarget("Resentment");

  // First: the engine agrees this set really does have both skills.
  const b = { weapon: null, pieces: {}, talisman: null };
  for (const s of ["head", "chest", "arms", "waist", "legs"]) {
    const hit = Object.entries(data.armor[s]).find(([, a]) => /^Redhelm /.test(a.n) && a.rar === 11);
    b.pieces[s] = { id: Number(hit[0]), lv: 0, decos: [] };
  }
  const direct = E.compute(b, data);
  check(direct.treePoints[focus[0]] === undefined && direct.treePoints[resent[0]] === undefined,
    "the Redhelm set has no Focus or Resentment points at all");
  check(direct.soulGrants.some(g => g.name === "Focus") && direct.soulGrants.some(g => g.name === "Resentment"),
    "yet its Soul grants both");

  // Then: the search can actually find it.
  const targets = [focus, resent];
  const t0 = Date.now();
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 0,
    talismans: [], maxResults: 20000, timeBudgetMs: 60000 }, data);
  const soulSets = res.results.filter(r => r.engine.soulGrants.length > 0);
  console.log(`  (${Date.now() - t0} ms, ${res.results.length} results, ${soulSets.length} of them Soul-driven)`);
  check(soulSets.length > 0, "the search finds a set whose skills come only from a Soul");
  check(res.results.some(({ set }) => /^Redhelm /.test(data.armor.head[set.pieces.head.id].n)
    && /^Redhelm /.test(data.armor.legs[set.pieces.legs.id].n)), "specifically, the full Redhelm set");
  // Every set offered must genuinely have both skills, however it got them.
  check(res.results.every(({ engine }) =>
    [focus, resent].every(([t, p]) =>
      (engine.treePoints[t] || 0) >= p
      || engine.active.some(a => a.tree === t && a.threshold >= p)
      || engine.soulGrants.some(g => g.tree === t && g.threshold >= p))),
    "and every result really does activate both skills");
  // No duplicates, since the Soul passes revisit armor the main pass saw.
  const keys = res.results.map(({ set }) =>
    ["head", "chest", "arms", "waist", "legs"].map(s => set.pieces[s].id).join("/"));
  check(new Set(keys).size === keys.length, "no set is reported twice across the passes");
}

console.log("progression gating (Village / Hub stars):");
{
  const charm = load("charm.js");
  const targets = [[treeId("Attack"), 10]];
  const base = { targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, talismans: [], maxResults: 200 };
  const rarityOf = res => res.results.flatMap(({ set }) =>
    ["head", "chest", "arms", "waist", "legs"].map(s => data.armor[s][set.pieces[s].id].rar));

  // Unset progression must behave exactly as before the filter existed.
  const openEnded = S.search(base, data);
  const explicitMax = S.search({ ...base, villageStar: 10, hubStar: 13 }, data);
  check(openEnded.results.length === explicitMax.results.length,
    "leaving progression unset matches searching at full progression");

  // Early game: only low-rank gear can appear.
  const early = S.search({ ...base, villageStar: 2, hubStar: 1 }, data);
  check(early.results.length > 0, "early progression still finds sets");
  const earlyMax = Math.max(...rarityOf(early));
  check(earlyMax <= 4, `early-game sets use only low rarity gear (max rarity ${earlyMax})`);
  check(Math.max(...rarityOf(openEnded)) > earlyMax, "endgame reaches gear early game cannot");

  // Every piece returned must genuinely be craftable at that progression.
  const legal = early.results.every(({ set }) =>
    ["head", "chest", "arms", "waist", "legs"].every(s => {
      const a = data.armor[s][set.pieces[s].id];
      if (a.hub === undefined) return true;                       // ungated event gear
      const byHub = a.hub !== 99 && 1 >= a.hub, byVil = a.vil !== 99 && 2 >= a.vil;
      return a.andF ? byHub && byVil : byHub || byVil;
    }));
  check(legal, "every piece in an early-game set is actually unlocked by then");

  // The two star tracks are independent: a village-only piece (hub 99) must be
  // reachable from the village side alone, and vice versa.
  const villageOnly = Object.values(data.armor.head).find(a => a.hub === 99 && a.vil <= 3 && !a.andF);
  if (villageOnly) {
    check(!S.search({ ...base, villageStar: 1, hubStar: 13 }, data).results.some(({ set }) =>
      data.armor.head[set.pieces.head.id].n === villageOnly.n),
      `${villageOnly.n} (village ${villageOnly.vil}, never in hub) is absent below its village star`);
  }
  // AND-flagged gear needs both tracks, not just one.
  const andPiece = Object.values(data.armor.head).find(a => a.andF && a.hub < 99 && a.vil < 99);
  if (andPiece) {
    const onlyHub = { ...base, villageStar: 1, hubStar: 13, maxResults: 5000 };
    check(!S.search(onlyHub, data).results.some(({ set }) =>
      data.armor.head[set.pieces.head.id].n === andPiece.n),
      `${andPiece.n} (needs village ${andPiece.vil} AND hub ${andPiece.hub}) stays out with only hub met`);
  }
}

console.log("the exact reported bug: My Talismans mode, 2 stored charms:");
{
  const charm = load("charm.js");
  const targets = [[treeId("Haphazard"), 10], [treeId("Tenderizer"), 10], [treeId("Critical Up"), 10],
    [treeId("Spirit"), 15], [treeId("Heavy Up"), 10]];
  const myTalismans = [
    { rar: 8, slots: 3, sk: [[treeId("Normal Up"), 6]] },
    { rar: 10, slots: 0, sk: [[treeId("Ammo Saver"), 7]] },
  ];
  const q = { targets, gender: 0, cls: "G", maxRar: 11, weaponSlots: 0, talismans: myTalismans, maxResults: 30, timeBudgetMs: 30000 };
  const t0 = Date.now();
  const res = S.search(q, data);
  const ms = Date.now() - t0;
  console.log(`  ${res.results.length} sets, ${ms} ms, complete ${res.complete}`);
  check(res.complete, "  search runs to completion rather than timing out");
  check(ms < 3000, `  answers in under 3s (took ${ms} ms)`);
}

console.log("a Soul bought with jewels rather than worn:");
{
  // Soul of Yukumo activates off five Yukumo Jwls and hands over Honey Hunter
  // and Water Res +15 outright. Every part of the search that judged a Soul on
  // the armor alone was blind to that: the pass for the Soul was switched off
  // before it ran, and the leaf that did reach it still demanded points in
  // Honey and Water Res that no piece was ever going to supply.
  const yukumo = treeId("Yukumo"), honey = treeId("Honey"), waterRes = treeId("Water Res");
  const grants = data.souls[yukumo] && data.souls[yukumo][10];
  check(!!grants && grants.some(([t, p]) => t === honey && p >= 10)
    && grants.some(([t, p]) => t === waterRes && p >= 10),
    "Soul of Yukumo grants Honey Hunter and Water Res +15");
  check(Object.values(data.decos).some(d => d.sk.some(([t, p]) => t === yukumo && p > 0)),
    "and a Yukumo jewel exists to buy it with");

  const targets = [[honey, 10], [waterRes, 10]];
  const tal = { rar: 7, slots: 1, sk: [[treeId("Sharpness"), 3]] };
  const res = S.search({ targets, gender: 1, cls: "B", maxRar: 11, weaponSlots: 0,
    talismans: [tal], maxResults: 20, timeBudgetMs: 60000 }, data);
  check(res.results.length > 0, "the search finds sets for skills only the Soul can give");
  check(verifyAll(res, targets), "and every one of them really has both skills");
  const viaSoul = res.results.some(({ set }) => {
    const r = E.compute({ weapon: set.weapon, pieces: set.pieces, talisman: set.talisman }, data);
    return (r.treePoints[honey] || 0) < 10 && r.soulGrants.some(gr => gr.tree === honey);
  });
  check(viaSoul, "at least one owes Honey Hunter to the Soul, not to points");
  const gemmed = res.results.some(({ set }) =>
    Object.entries(set.pieces).reduce((n, [slot, p]) =>
      n + ((data.armor[slot][p.id].sk.find(([t]) => t === yukumo) || [0, 0])[1]), 0) < 10);
  check(gemmed, "and one reaches the Soul with jewels rather than with armor points");
}

console.log(failed ? `\n${failed} FAILURE(S)` : "\nall search tests passed");
process.exit(failed ? 1 : 0);
