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
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, talisman: null, maxResults: 50 }, data);
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
  const tal = { slots: 3, sk: [[treeId("Attack"), 5]] };
  const t0 = Date.now();
  const res = S.search({ targets, gender: 1, cls: "G", maxRar: 11, weaponSlots: 0, talisman: tal, maxResults: 50 }, data);
  console.log(`  (${Date.now() - t0} ms, ${res.explored} finalized, ${res.results.length} results)`);
  check(res.results.length > 0, "finds sets");
  check(verifyAll(res, targets), "every result re-verifies through the engine");
  check(genderOk(res, 1), "no male-only pieces");
}

console.log("triple target, tight: HG Earplugs + Attack Up (L) + Weakness Exploit:");
{
  const targets = [[treeId("Hearing"), 15], [treeId("Attack"), 20], [treeId("Tenderizer"), 10]];
  const t0 = Date.now();
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 3, talisman: { slots: 0, sk: [[treeId("Attack"), 10]] }, maxResults: 30 }, data);
  console.log(`  (${Date.now() - t0} ms, ${res.explored} finalized, ${res.results.length} results)`);
  check(res.results.length > 0, "finds sets (this combo is known possible in MHGU)");
  check(verifyAll(res, targets), "every result re-verifies through the engine");
}

console.log("impossible: Skill +2 without Neset-tier rarity:");
{
  const targets = [[treeId("Secret Arts"), 10]];
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 5, weaponSlots: 3, talisman: null, maxResults: 10 }, data);
  check(res.results.length === 0 && res.complete, "no results, search terminates");
}

console.log("neset cascade found by search: Skill +2 + Double Talisman:");
{
  const targets = [[treeId("Secret Arts"), 10], [treeId("Talisman Boost"), 10]];
  const res = S.search({ targets, gender: 0, cls: "B", maxRar: 11, weaponSlots: 0, talisman: null, maxResults: 10 }, data);
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
  const q = { targets, gender: 0, cls: "B", maxRar: 3, weaponSlots: 3, talisman: null, maxResults: 100000 };
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

console.log(failed ? `\n${failed} FAILURE(S)` : "\nall search tests passed");
process.exit(failed ? 1 : 0);
