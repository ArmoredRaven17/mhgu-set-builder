// test-ta-sets.mjs — run the search against real speedrun sets.
//
//   node scripts/test-ta-sets.mjs [one|two|both] [limit] [timeoutMs]
//
// scripts/ta-sets.json holds 332 skill lists taken from the community MHXX/GU
// speedrun archive: sets people actually built and used, which is a far better
// test than anything invented here. Each one is a query the search must answer.
//
//   two — talismans with two skills. Most TA runners edit their save, so this
//         is the pass that should find nearly everything.
//   one — one-skill talismans only. Not every runner edits saves, so plenty of
//         these sets are reachable with an ordinary charm; this pass is the
//         stricter one and the more useful regression guard.
//
// A "not found" is not automatically a bug: the archive records a set, not the
// gender or the weapon's slots, and some runs use gear this data gates
// differently. What matters is the COUNT — record it before a change and
// require it not to fall afterwards.
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
const S = globalThis.SBSearch;

const data = {
  skills: load("skills.js"), souls: load("souls.js"),
  decos: load("decos.js"), armor: load("armor.js"),
};
const charm = load("charm.js");
const corpus = JSON.parse(readFileSync(join(ROOT, "scripts", "ta-sets.json"), "utf8"));

// First activation of each skill name — the archive names a skill, not a tree.
const byName = new Map();
for (const [tree, ladder] of Object.entries(data.skills.active))
  for (const [pts, name] of ladder)
    if (pts > 0 && !byName.has(name)) byName.set(name, [Number(tree), pts]);

const GUNNER = new Set(["LBG", "HBG", "Bow"]);
const MODE = (process.argv[2] || "both").toLowerCase();
const LIMIT = Number(process.argv[3] || 0) || corpus.sets.length;
const BUDGET = Number(process.argv[4] || 0) || 20000;

function runPass(twoSkill) {
  const label = twoSkill ? "two-skill" : "one-skill";
  let found = 0, missing = 0, unmapped = 0, slowest = 0;
  const misses = [];
  const t00 = Date.now();
  for (const c of corpus.sets.slice(0, LIMIT)) {
    const targets = c.skills.map(n => byName.get(n)).filter(Boolean);
    if (targets.length !== c.skills.length) { unmapped++; continue; }
    const cls = GUNNER.has(c.sheet) ? "G" : "B";
    const talismans = S.generateTalismans(targets.map(t => t[0]), charm, { twoSkill });
    // The archive records neither gender nor the weapon's slots, so a set
    // counts as reachable if either gender can produce it. Only three weapon
    // slots are tried: more slots can never yield fewer sets, so the most
    // generous setting decides reachability, and sweeping downward would only
    // establish the minimum — which this pass does not need.
    let hit = false, ms = 0;
    for (const gender of [0, 1]) {
      const t0 = Date.now();
      const r = S.search({ targets, gender, cls, maxRar: 11, weaponSlots: 3,
        talismans, maxResults: 1, timeBudgetMs: BUDGET }, data);
      ms += Date.now() - t0;
      if (r.results.length) { hit = true; break; }
    }
    if (ms > slowest) slowest = ms;
    if (hit) found++;
    else { missing++; misses.push(`${c.sheet}/${c.monster || "?"}: ${c.skills.join(" / ")}`); }
  }
  const secs = Math.round((Date.now() - t00) / 1000);
  console.log(`${label}: ${found} found, ${missing} not found`
    + (unmapped ? `, ${unmapped} unmappable` : "")
    + ` — ${secs}s, slowest set ${(slowest / 1000).toFixed(1)}s`);
  if (misses.length) {
    console.log(`  not found (${misses.length}):`);
    for (const m of misses) console.log(`    ${m}`);
  }
  return { found, missing };
}

console.log(`${corpus.sets.length} sets from ${corpus.source}`);
if (MODE === "two" || MODE === "both") runPass(true);
if (MODE === "one" || MODE === "both") runPass(false);
