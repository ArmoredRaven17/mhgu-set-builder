// build-data.mjs — generate every table under docs/data/ for the set builder.
//
//   node scripts/build-data.mjs [--tracker <repo>] [--editor <repo>]
//                               [--check-box <repo>] [--athena <dir>]
//
// Sources (nothing is scraped; all inputs already exist locally):
//   <tracker>/docs/data/stats/armor_*.json   armor stats, romfs-derived
//   <tracker>/docs/data/stats/<class>.json   weapon stats per class (Kiranico)
//   <tracker>/docs/data/catalog.js           names, gender, pairs, weapon index
//   <tracker>/docs/data/armor_levels.js      max upgrade level per piece
//   <tracker>/data-src/mhgu.db               skill trees, activation thresholds,
//                                            decorations, soul-skill descriptions
//   <editor>/src/assets/talisman_charm_table.json  charm roll ranges per tier
//
// Every output keys skills by the game's skill-tree id (mhgu.db skill_trees).
// The tracker's armor stats store tree NAMES; they are resolved to ids here and
// the build fails if any name doesn't resolve.
//
// Optional cross-checks:
//   --check-box  diff decorations against the Equipment Box's EQ_SKILLS.deco
//   --athena     count Athena's ASS compound_skills.txt lines vs the db's souls

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data");

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const TRACKER = argOf("--tracker", join(ROOT, "..", "mhgu-collection-tracker"));
const EDITOR = argOf("--editor", join(ROOT, "..", "mhgu-editor"));
const BOX = argOf("--check-box", null);
const ATHENA = argOf("--athena", null);

const J = p => JSON.parse(readFileSync(p, "utf8"));
// catalog.js / armor_levels.js are `window.X = {...};` — slice off the prefix.
const JGlobal = p => {
  const s = readFileSync(p, "utf8");
  return JSON.parse(s.slice(s.indexOf("=") + 1).replace(/;\s*$/, ""));
};
const assert = (cond, msg) => { if (!cond) { console.error(`ASSERT FAILED: ${msg}`); process.exit(1); } };
const emit = (file, global, obj) => {
  writeFileSync(join(OUT, file), `window.${global} = ${JSON.stringify(obj)};\n`);
  console.log(`  ${file}  (${global})`);
};

mkdirSync(join(OUT, "weapons"), { recursive: true });
const db = new DatabaseSync(join(TRACKER, "data-src", "mhgu.db"), { readOnly: true });

// ── Skill trees + activation thresholds ──────────────────────────────────
const trees = {};
for (const r of db.prepare("SELECT _id, name FROM skill_trees").all()) trees[r._id] = r.name;
const treeIdByName = new Map(Object.entries(trees).map(([id, n]) => [n, Number(id)]));
assert(Object.keys(trees).length === 205, `205 skill trees (got ${Object.keys(trees).length})`);
assert(trees[203] === "Torso Up", "tree 203 is Torso Up");

const active = {};
const skillRows = db.prepare(
  "SELECT _id, skill_tree_id AS tree, required_skill_tree_points AS pts, name, description AS d FROM skills"
).all();
assert(skillRows.length === 326, `326 activated skills (got ${skillRows.length})`);
for (const r of skillRows) (active[r.tree] ||= []).push([r.pts, r.name, r.d]);
for (const list of Object.values(active)) list.sort((a, b) => a[0] - b[0]);

// Every activated-skill name → [treeId, pts], for resolving soul grants.
const skillByName = new Map();
for (const r of skillRows) {
  assert(!skillByName.has(r.name) || skillByName.get(r.name)[0] === r.tree,
    `skill name "${r.name}" is unambiguous`);
  skillByName.set(r.name, [r.tree, r.pts]);
}

// ── Soul / compound skills ───────────────────────────────────────────────
// The db encodes each compound skill's expansion in its own description:
//   Combines the effects of "Earplugs" and "Wind Res (Hi)."
// Trailing punctuation lands inside the closing quote; strip it.
const souls = {};
let soulCount = 0, grantCount = 0;
for (const r of skillRows) {
  if (!/^Combines the effects of/.test(r.d)) continue;
  const names = [...r.d.matchAll(/"([^"]+)"/g)].map(m => m[1].replace(/[.,]$/, ""));
  assert(names.length >= 2, `compound "${r.name}" quotes at least two skills`);
  const grants = names.map(n => {
    assert(skillByName.has(n), `soul grant "${n}" (of ${r.name}) resolves to a skill`);
    const [gTree, gPts] = skillByName.get(n);
    return [gTree, gPts];
  });
  (souls[r.tree] ||= {})[r.pts] = grants;
  soulCount++; grantCount += grants.length;
}
assert(soulCount === 65, `65 compound skills (got ${soulCount})`);
console.log(`souls: ${soulCount} compounds, ${grantCount} grants, all resolved`);

// ── Decorations ──────────────────────────────────────────────────────────
const decos = {};
const decoRows = db.prepare(`
  SELECT d._id AS id, i.name, i.rarity, d.num_slots AS slots
  FROM decorations d JOIN items i ON i._id = d._id`).all();
assert(decoRows.length === 242, `242 decorations (got ${decoRows.length})`);
const decoSkillStmt = db.prepare(
  "SELECT skill_tree_id AS tree, point_value AS pts FROM item_to_skill_tree WHERE item_id = ?");
for (const r of decoRows) {
  const sk = decoSkillStmt.all(r.id).map(s => [s.tree, s.pts]);
  assert(sk.length >= 1 && sk.length <= 2, `deco ${r.name} has 1-2 skills`);
  decos[r.id] = { n: r.name, slots: r.slots, rar: r.rarity, sk };
}

// ── Charm (talisman) roll tables ─────────────────────────────────────────
// Editor table: {tier: [206][4]} indexed by tree id → [s1min,s1max,s2min,s2max];
// all-zero rows mean the tier can't roll that tree at all.
const charmSrc = J(join(EDITOR, "src", "assets", "talisman_charm_table.json"));
const TIERS = ["mystery", "shining", "timeworn", "enduring"];
const charm = { tiers: {}, names: J(join(EDITOR, "src", "assets", "talisman.json")) };
for (const tier of TIERS) {
  const arr = charmSrc[tier];
  assert(Array.isArray(arr) && arr.length === 206, `${tier} charm table is [206]`);
  const t = {};
  for (let treeId = 1; treeId < arr.length; treeId++) {
    const row = arr[treeId];
    if (row.every(v => v === 0)) continue;
    assert(trees[treeId], `charm ${tier} tree ${treeId} exists`);
    t[treeId] = row;
  }
  charm.tiers[tier] = t;
}
assert(charm.tiers.mystery[1] && charm.tiers.mystery[1][0] === 1 && charm.tiers.mystery[1][1] === 5,
  "mystery Poison rolls 1-5 as skill 1");
assert(Object.keys(charm.names).length === 10 && charm.names[1] === "Pawn Talisman"
  && charm.names[10] === "Creator Talisman", "10 talisman names, Pawn to Creator");

// ── Armor ────────────────────────────────────────────────────────────────
// Stats (romfs-derived, authoritative) joined with the catalog (names, gender,
// pairs, sort order) and armor_levels (max upgrade level). Ids present in only
// one source are dropped and counted. Gender is normalized to the catalog
// convention: 0 male-only, 1 female-only, 2 either (stats `gen` uses 1=male,
// 0=female, 2=either and is only a fallback).
const catalog = JGlobal(join(TRACKER, "docs", "data", "catalog.js"));
const armorLevels = JGlobal(join(TRACKER, "docs", "data", "armor_levels.js"));
const SLOTS = ["head", "chest", "arms", "waist", "legs"];
const isDummy = n => /\(DUMMY\)/i.test(n);

// ── When a piece becomes craftable (Athena's availability table) ─────────
// The game's own tables don't record this and mhgu.db can't supply it — its
// item_to_quest is all but empty (88 rows), and deriving a rank from crafting
// materials over-estimates (Hunter's Helm computes as village 2, truly 1).
// Athena's transcription is the only reliable source, and its rarity/slots/
// defense agree with the romfs data we already trust.
//
// Per row: [5] Gathering-Hall (hub/HR) star, [6] Village star, 99 = never
// obtainable from that source, [7] 0 = either condition suffices, 1 = both
// required. Names come from the line-parallel English list, where English
// line N corresponds to data line N+1 (the data file carries a # header).
const ATHENA_SLOT_FILE = { head: "head", chest: "body", arms: "arms", waist: "waist", legs: "legs" };
function loadAvailability() {
  if (!ATHENA) return null;
  const bySlot = {};
  for (const slot of SLOTS) {
    const base = ATHENA_SLOT_FILE[slot];
    const rows = readFileSync(join(ATHENA, "Data", `${base}.txt`), "utf8").split(/\r?\n/);
    const names = readFileSync(join(ATHENA, "Data", "Languages", "English", `${base}.txt`), "utf8")
      .replace(/^﻿/, "").split(/\r?\n/);
    const map = new Map();
    let dupes = 0;
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i].trim()) continue;
      const raw = (names[i - 1] || "").trim();
      if (!raw) continue;
      // Deviant gear is listed once per upgrade stage ("Redhelm Helm LV1/LV6/
      // LV14"); the LV1 row is when the piece first becomes craftable, and it
      // comes first, so first-match-wins lands on it naturally.
      const name = raw.replace(/\s+LV\d+$/i, "");
      const c = rows[i].split(",");
      const hub = Number(c[5]), vil = Number(c[6]), andF = Number(c[7]) === 1;
      if (!Number.isFinite(hub) || !Number.isFinite(vil)) continue;
      if (map.has(name)) { dupes++; continue; }
      map.set(name, { hub, vil, andF });
    }
    bySlot[slot] = { map, dupes };
  }
  return bySlot;
}
const availability = loadAvailability();
if (!availability)
  console.log("WARNING: no --athena path given; armor will carry no progression data "
    + "and the search's Village/Hub filters will match everything.");

const armor = {};
const dropped = { statsOnly: 0, catalogOnly: 0, dummy: 0 };
const availStats = { matched: 0, unmatched: 0, dupes: 0 };
let torsoUpPieces = 0;
for (const slot of SLOTS) {
  const stats = J(join(TRACKER, "docs", "data", "stats", `armor_${slot}.json`)).byId;
  const avail = availability ? availability[slot] : null;
  if (avail) availStats.dupes += avail.dupes;
  const out = {};
  for (const e of catalog.armor[slot].entries) {
    const [id, name, , , setName, gender, pairId, , ord] = e;
    const s = stats[id];
    if (!s) { dropped.catalogOnly++; continue; }
    if (isDummy(name)) { dropped.dummy++; continue; }
    const sk = (s.sk || []).map(([treeName, pts]) => {
      const treeId = treeIdByName.get(treeName);
      assert(treeId, `armor skill "${treeName}" (${slot} ${id} ${name}) resolves to a tree`);
      return [treeId, pts];
    });
    if (sk.some(([t]) => t === 203)) torsoUpPieces++;
    out[id] = {
      n: name, def: s.def, lv: s.lv, res: s.res, slots: s.slots, sk,
      rar: s.rar, cls: s.cls, gender, pair: pairId,
      maxLv: armorLevels[slot][id] || (s.lv ? s.lv.length : 1),
      ord, set: setName || 0,
    };
    // A piece we can't place stays ungated rather than hidden: guessing it
    // away would silently rob the search of real options.
    const av = avail && avail.map.get(name);
    if (av) {
      out[id].hub = av.hub; out[id].vil = av.vil;
      if (av.andF) out[id].andF = 1;
      availStats.matched++;
    } else if (avail) availStats.unmatched++;
  }
  for (const id of Object.keys(stats))
    if (!out[id]) dropped.statsOnly++;   // includes the dummies dropped above
  armor[slot] = out;
}
assert(torsoUpPieces === 25, `25 Torso Up pieces across slots (got ${torsoUpPieces})`);
{
  // Family-style spot checks against known pieces.
  const lh = armor.head[1];
  assert(lh && lh.n === "Leather Headgear" && lh.slots === 1, "head 1 is Leather Headgear with 1 slot");
  assert(lh.sk.length === 1 && trees[lh.sk[0][0]] === "Whim" && lh.sk[0][1] === 2,
    "Leather Headgear carries Whim +2");
}
console.log(`armor: ${SLOTS.map(s => `${s} ${Object.keys(armor[s]).length}`).join(", ")}`
  + ` | dropped: ${dropped.dummy} dummy, ${dropped.catalogOnly} catalog-only, ${dropped.statsOnly} stats-only`);
if (availability) {
  console.log(`availability: ${availStats.matched} pieces gated, ${availStats.unmatched} left ungated`
    + ` (no name match), ${availStats.dupes} duplicate Athena rows skipped`);
  // Spot checks against the table read by hand.
  assert(armor.head[1].hub === 1 && armor.head[1].vil === 1, "Leather Headgear is village 1 / hub 1");
  assert(armor.head[4].hub === 99 && armor.head[4].vil === 2,
    `Hunting Helm is village-only at 2 (got hub ${armor.head[4].hub}, vil ${armor.head[4].vil})`);
  // Deviant gear must resolve to its LV1 row, not LV6/LV14.
  const redhelm = Object.values(armor.head).find(a => a.n === "Redhelm Helm");
  assert(redhelm && redhelm.hub === 2 && redhelm.vil === 2 && redhelm.andF === 1,
    `Redhelm Helm takes its LV1 unlock (got ${JSON.stringify(redhelm && [redhelm.hub, redhelm.vil, redhelm.andF])})`);
  // The vast majority must match, or the name join has drifted.
  const ratio = availStats.matched / (availStats.matched + availStats.unmatched);
  assert(ratio > 0.9, `over 90% of pieces matched Athena's table (got ${(ratio * 100).toFixed(1)}%)`);
}

// ── Weapons ──────────────────────────────────────────────────────────────
// Index (sync, small) + one lazy-fetched detail file per class with the deco
// slot glyphs ("◯◯―") pre-parsed to integers.
const weaponIndex = {};
const weaponClasses = [];
for (const [cls, cat] of Object.entries(catalog.weapons)) {
  weaponClasses.push({ key: cls, label: cat.label, icon: cat.icon });
  // entry: [id, name, rarity, finalName, maxLevel, stages, kiranicoOrder, elementMask]
  weaponIndex[cls] = cat.entries
    .filter(e => !isDummy(e[1]))
    .map(e => [e[0], e[1], e[2], e[3], e[4], e[7]]);
  const stats = J(join(TRACKER, "docs", "data", "stats", `${cls}.json`)).byId;
  const byId = {};
  for (const [id, levels] of Object.entries(stats)) {
    byId[id] = levels.map(l => ({ ...l, slots: (l.slots.match(/◯/g) || []).length }));
  }
  writeFileSync(join(OUT, "weapons", `${cls}.json`), JSON.stringify({ cls, byId }));
}
assert(weaponClasses.length === 14, "14 weapon classes");
{
  const gs = J(join(OUT, "weapons", "great_sword.json")).byId["1"];
  assert(gs[0].raw === 60 && gs[0].slots === 0, "Petrified Blade LV1: 60 raw, 0 slots");
  assert(gs[gs.length - 1].slots === 3, "Sophos Blade LV11: 3 slots");
}
console.log(`weapons: ${weaponClasses.length} classes, `
  + Object.values(weaponIndex).reduce((a, l) => a + l.length, 0) + " trees");

// ── Optional cross-checks ────────────────────────────────────────────────
if (BOX) {
  const eq = JGlobal(join(BOX, "docs", "data", "skills.js"));
  let diffs = 0;
  for (const [id, [name, cost, s1, s2]] of Object.entries(eq.deco)) {
    const mine = decos[id];
    if (!mine) { console.log(`  box deco ${id} "${name}" missing here`); diffs++; continue; }
    const boxSk = [s1, s2].filter(Boolean).map(([n, p]) => [treeIdByName.get(n), p]);
    const same = mine.n === name && mine.slots === cost &&
      JSON.stringify([...mine.sk].sort()) === JSON.stringify([...boxSk].sort());
    if (!same) { console.log(`  deco ${id} differs: ${JSON.stringify(mine)} vs box ${JSON.stringify([name, cost, s1, s2])}`); diffs++; }
  }
  console.log(`check-box: ${Object.keys(eq.deco).length} box decos compared, ${diffs} differences`);
}
if (ATHENA) {
  const lines = readFileSync(join(ATHENA, "Data", "compound_skills.txt"), "latin1")
    .split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
  console.log(`athena: compound_skills.txt has ${lines.length} entries vs db ${soulCount}`);
}

// ── Emit ─────────────────────────────────────────────────────────────────
console.log("writing docs/data/:");
emit("skills.js", "SB_SKILLS", { trees, active });
emit("souls.js", "SB_SOULS", souls);
emit("decos.js", "SB_DECOS", decos);
emit("charm.js", "SB_CHARM", charm);
emit("armor.js", "SB_ARMOR", armor);
emit("weapons.js", "SB_WEAPONS", { classes: weaponClasses, index: weaponIndex });
console.log("done.");
