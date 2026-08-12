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
const verifyAll = (res, targets) => res.results.every(({ set, engine }) => {
  const r = E.compute({ weapon: set.weapon, pieces: set.pieces, talisman: set.talisman }, data);
  return targets.every(([t, p]) => (r.treePoints[t] || 0) >= p) && r.problems.length === 0;
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
  check(oneAtk.filter(t => t.sk[0][0] === atk && t.sk[0][1] === atkPts[0])
    .map(t => t.slots).sort().join(",") === "0,1,2,3", "each point value is offered at every slot count");
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

console.log(failed ? `\n${failed} FAILURE(S)` : "\nall search tests passed");
process.exit(failed ? 1 : 0);
