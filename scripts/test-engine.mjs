// test-engine.mjs — engine unit tests on synthetic tables plus integration
// tests on the real generated data.  Run:  node scripts/test-engine.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = f => {
  const s = readFileSync(join(ROOT, "docs", "data", f), "utf8");
  return JSON.parse(s.slice(s.indexOf("=") + 1).replace(/;\s*\n?$/, ""));
};
await import(`file://${join(ROOT, "docs", "engine.js").replace(/\\/g, "/")}`);
const E = globalThis.SBEngine;

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`);
  else { console.error(`  FAIL ${msg}`); failed++; }
};
const emptyBuild = () => ({ weapon: null, pieces: { head: null, chest: null, arms: null, waist: null, legs: null }, talisman: null });

// ── Synthetic tables: controlled mechanics ───────────────────────────────
// Tree 1 "Attack" with a full ladder, tree 203 Torso Up, tree 9 a soul tree
// granting (1,+10) and (2,+10).
const syn = {
  skills: {
    trees: { 1: "Attack", 2: "Guard", 9: "Soul", 203: "Torso Up" },
    active: {
      1: [[-20, "Attack Down (L)", ""], [-15, "Attack Down (M)", ""], [-10, "Attack Down (S)", ""],
          [10, "Attack Up (S)", ""], [15, "Attack Up (M)", ""], [20, "Attack Up (L)", ""]],
      2: [[10, "Guard +1", ""], [15, "Guard +2", ""]],
      9: [[10, "Soul", ""]],
    },
  },
  souls: { 9: { 10: [[1, 10], [2, 10]] } },
  decos: {
    100: { n: "Atk Jwl 1", slots: 1, rar: 4, sk: [[1, 1]] },
    101: { n: "Atk Jwl 3", slots: 3, rar: 4, sk: [[1, 5]] },
    102: { n: "Cursed Jwl", slots: 1, rar: 4, sk: [[2, 1], [1, -2]] },
  },
  armor: {
    head:  { 1: { n: "H", def: [1, 10], lv: [1, 10], res: [1, 0, 0, 0, 0], slots: 3, sk: [[1, 4]], rar: 1, cls: "A", gender: 2, pair: 0, maxLv: 2, ord: 1, set: 0 },
             2: { n: "HT", def: [1, 10], lv: [1, 10], res: [0, 0, 0, 0, 0], slots: 0, sk: [[203, 0]], rar: 1, cls: "A", gender: 2, pair: 0, maxLv: 2, ord: 2, set: 0 } },
    chest: { 1: { n: "C", def: [2, 20], lv: [2, 20], res: [0, 2, 0, 0, 0], slots: 2, sk: [[1, 3]], rar: 1, cls: "A", gender: 2, pair: 0, maxLv: 2, ord: 1, set: 0 } },
    arms:  { 1: { n: "A", def: [1, 10], lv: [1, 10], res: [0, 0, 0, 0, 0], slots: 0, sk: [[203, 0]], rar: 1, cls: "A", gender: 2, pair: 0, maxLv: 2, ord: 1, set: 0 } },
    waist: { 1: { n: "W", def: [1, 10], lv: [1, 10], res: [0, 0, 0, 0, 0], slots: 0, sk: [[9, 10]], rar: 1, cls: "A", gender: 2, pair: 0, maxLv: 2, ord: 1, set: 0 } },
    legs:  { 1: { n: "L", def: [1, 10], lv: [1, 10], res: [0, 0, 0, 0, 0], slots: 0, sk: [[1, 3]], rar: 1, cls: "A", gender: 2, pair: 0, maxLv: 2, ord: 1, set: 0 } },
  },
};

console.log("threshold walk:");
for (const [pts, want] of [[9, null], [10, "Attack Up (S)"], [14, "Attack Up (S)"], [15, "Attack Up (M)"], [20, "Attack Up (L)"],
                           [-9, null], [-10, "Attack Down (S)"], [-17, "Attack Down (M)"], [-20, "Attack Down (L)"]]) {
  const b = emptyBuild();
  b.talisman = { slots: 0, sk: [[1, pts]], decos: [] };
  const r = E.compute(b, syn);
  const got = r.active.find(a => a.tree === 1);
  check((got ? got.name : null) === want, `${pts} pts of Attack -> ${want || "nothing"}`);
}

console.log("torso up:");
{
  const b = emptyBuild();
  b.pieces.chest = { id: 1, lv: 2, decos: [100] };   // chest: Attack 3 + Atk Jwl 1
  b.pieces.head = { id: 2, lv: 2, decos: [] };        // Torso Up
  b.pieces.arms = { id: 1, lv: 2, decos: [] };        // Torso Up
  const r = E.compute(b, syn);
  check(r.torsoUpCount === 2, "two Torso Up pieces counted");
  check(r.treePoints[1] === (3 + 1) * 3, `chest skill AND chest deco points x3 (got ${r.treePoints[1]})`);
  check(!(203 in r.treePoints), "Torso Up itself contributes no points");
  const b2 = emptyBuild();
  b2.pieces.chest = { id: 1, lv: 2, decos: [100] };
  b2.pieces.legs = { id: 1, lv: 2, decos: [] };       // Attack 3, not chest
  b2.pieces.head = { id: 2, lv: 2, decos: [] };
  const r2 = E.compute(b2, syn);
  check(r2.treePoints[1] === (3 + 1) * 2 + 3, `non-chest points unmultiplied (got ${r2.treePoints[1]})`);
}

console.log("negatives and stacking:");
{
  const b = emptyBuild();
  b.weapon = { slots: 3, def: 0, decos: [102, 102, 102] };  // 3x Attack -2
  b.pieces.head = { id: 1, lv: 2, decos: [101] };            // Attack 4 + 5 = 9
  const r = E.compute(b, syn);
  check(r.treePoints[1] === 9 - 6, `mixed deco math (got ${r.treePoints[1]})`);
  check(r.treePoints[2] === 3, "secondary deco skill counted");
  const b2 = emptyBuild();
  b2.weapon = { slots: 3, def: 0, decos: [102, 102, 102] };
  b2.talisman = { slots: 0, sk: [[1, -4]], decos: [] };
  const r2 = E.compute(b2, syn);
  check(r2.active.some(a => a.name === "Attack Down (S)" && a.negative), "-10 total surfaces Attack Down (S)");
}

console.log("souls:");
{
  const b = emptyBuild();
  b.pieces.waist = { id: 1, lv: 2, decos: [] };   // Soul tree +10
  const r = E.compute(b, syn);
  check(r.active.some(a => a.tree === 9 && a.soul), "compound skill activates and is marked");
  check(r.soulGrants.length === 2, "soul expands to its grants");
  check(r.soulGrants.some(s => s.name === "Attack Up (S)") && r.soulGrants.some(s => s.name === "Guard +1"), "grant names resolved");
  // A grant already activated naturally is not duplicated.
  b.talisman = { slots: 0, sk: [[1, 10]], decos: [] };
  const r2 = E.compute(b, syn);
  check(r2.active.some(a => a.tree === 1) && r2.soulGrants.length === 1, "naturally-active grant deduped");
}

console.log("slots and problems:");
{
  const b = emptyBuild();
  b.pieces.chest = { id: 1, lv: 2, decos: [101] };  // 3-slot deco in a 2-slot chest
  const r = E.compute(b, syn);
  check(r.slots.chest.used === 3 && r.slots.chest.total === 2, "slot use counted");
  check(r.problems.length === 1, "over-budget reported");
  const b2 = emptyBuild();
  b2.pieces.head = { id: 1, lv: 1, decos: [] };
  const r2 = E.compute(b2, syn);
  check(r2.defense === 1 && r2.defenseMax === 10, "below-max level uses the lv array");
}

// ── Real data ────────────────────────────────────────────────────────────
const data = {
  skills: load("skills.js"), souls: load("souls.js"),
  decos: load("decos.js"), armor: load("armor.js"),
};
const charm = load("charm.js");
const treeId = name => Number(Object.entries(data.skills.trees).find(([, n]) => n === name)[0]);

console.log("real data: Redhelm XR set (true soul):");
{
  const SLOT_NAMES = { head: "Redhelm Helm", chest: "Redhelm Mail", arms: "Redhelm Vambraces", waist: "Redhelm Faulds", legs: "Redhelm Greaves" };
  const b = emptyBuild();
  for (const [slot, n] of Object.entries(SLOT_NAMES)) {
    const hit = Object.entries(data.armor[slot]).find(([, e]) => e.n === n && e.rar === 11);
    check(!!hit, `${n} (rarity 11) exists`);
    if (hit) b.pieces[slot] = { id: Number(hit[0]), lv: hit[1].maxLv, decos: [] };
  }
  const r = E.compute(b, data);
  const rx = treeId("Redhelm X");
  check(r.treePoints[rx] >= 10, `Redhelm X reaches 10 (got ${r.treePoints[rx]})`);
  check(r.active.some(a => a.name === "Redhelm Soul X" && a.soul), "Redhelm Soul X activates as a compound");
  for (const n of ["Resentment", "Focus", "Marathon Runner"])
    check(r.active.some(a => a.name === n) || r.soulGrants.some(s => s.name === n), `soul grants ${n}`);
}

console.log("real data: talisman validation (rarity model):");
{
  const poison = treeId("Poison");
  const v = (rar, slots, sk) => E.validateTalisman({ rar, slots, sk }, charm, data.skills);
  check(Object.keys(charm.names).length === 10 && charm.names[1] === "Pawn Talisman", "10 talisman names shipped");
  check(E.TAL_TIER[1] === "mystery" && E.TAL_TIER[4] === "shining" && E.TAL_TIER[7] === "timeworn" && E.TAL_TIER[10] === "enduring",
    "rarity-to-tier mapping matches the editor");
  check(v(1, 0, [[poison, 3]]).length === 0, "Pawn (mystery) Poison +3 accepted");
  check(v(2, 0, [[poison, 9]]).length === 1, "Bishop (mystery) Poison +9 rejected (rolls 1-5)");
  check(v(1, 4, [[poison, 3]]).length === 1, "4 slots rejected");
  check(v(1, 0, [[poison, 3], [poison, 1]]).length >= 1, "duplicate skill rejected");
  check(v(0, 0, [[poison, 3]]).length === 1, "rarity 0 rejected");
  check(v(11, 0, [[poison, 3]]).length === 1, "rarity 11 rejected");
  // A tier that can't roll some tree as skill 1: present on enduring, absent on mystery.
  const enduring = charm.tiers.enduring, mystery = charm.tiers.mystery;
  const onlyEnduring = Object.keys(enduring).find(t => !(t in mystery));
  if (onlyEnduring)
    check(v(1, 0, [[Number(onlyEnduring), 1]]).length === 1, `tree ${onlyEnduring} not rollable on a Pawn (mystery)`);
}

console.log("real data: known classic set (Attack Up via decos):");
{
  // 5 x Atk Jwl 2 style check: Attack tree exists and ladder matches the game.
  const atk = treeId("Attack");
  const ladder = data.skills.active[atk];
  check(JSON.stringify(ladder.map(s => [s[0], s[1]])) ===
    JSON.stringify([[-20, "Attack Down (L)"], [-15, "Attack Down (M)"], [-10, "Attack Down (S)"], [10, "Attack Up (S)"], [15, "Attack Up (M)"], [20, "Attack Up (L)"]]),
    "Attack ladder matches the game");
}

console.log(failed ? `\n${failed} FAILURE(S)` : "\nall tests passed");
process.exit(failed ? 1 : 0);
