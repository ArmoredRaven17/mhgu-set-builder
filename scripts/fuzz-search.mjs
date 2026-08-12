// fuzz-search.mjs — differential fuzz for the set search.
//
//   node scripts/fuzz-search.mjs [seed] [trials]
//
// Build a random but LEGAL set, ask the engine which skills it activates, then
// demand the search find a set for those skills. The witness proves an answer
// exists, so an empty result is a search bug and the witness is the evidence.
// Nothing here is tuned to a particular query: the queries are generated.
//
// This is how the Soul-bought-with-jewels bug was found — Soul of Yukumo off
// five Yukumo Jwls, granting Honey Hunter and Water Res +15, which the search
// could not produce because it only ever looked for a Soul on the armor.
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
const charm = load("charm.js");
const SLOTS = ["head", "chest", "arms", "waist", "legs"];

// Seeded, so a failure can be reproduced exactly from the printed seed.
let seed = (Number(process.argv[2] || 1) >>> 0) || 1;
const rnd = () => {                       // mulberry32
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = a => a[Math.floor(rnd() * a.length)];
const int = n => Math.floor(rnd() * n);

const decos = Object.entries(data.decos).map(([id, d]) => ({ id: Number(id), slots: d.slots, sk: d.sk }));
// Trees worth building a set around: something can actually raise them.
const TREES = [...new Set(decos.flatMap(d => d.sk.filter(([, p]) => p > 0).map(([t]) => t)))]
  .filter(t => data.skills.active[t]);
const ptsIn = (sk, want) => sk.reduce((n, [t, p]) => n + (want.includes(t) ? p : 0), 0);

// Gem a slot toward whichever wanted tree is furthest behind. Assembling gear
// at random almost never crosses a threshold, so the witness is built the way
// a player builds: pieces and jewels aimed at a handful of skills.
function gemSlot(cap, want, running) {
  const out = [];
  let left = cap;
  while (left > 0) {
    const fit = decos.filter(d => d.slots <= left && d.sk.some(([t, p]) => want.includes(t) && p > 0));
    if (!fit.length) break;
    const behind = want.slice().sort((a, b) => (running[a] || 0) - (running[b] || 0));
    const aim = rnd() < 0.8 ? behind[0] : pick(want);
    const forAim = fit.filter(d => d.sk.some(([t, p]) => t === aim && p > 0));
    const d = pick(forAim.length ? forAim : fit);
    out.push(d.id); left -= d.slots;
    for (const [t, p] of d.sk) running[t] = (running[t] || 0) + p;
  }
  return out;
}

function randomTalisman(want) {
  const rar = 5 + int(6);
  const table = charm.tiers[E.TAL_TIER[rar]];
  let first = Object.entries(table).filter(([, r]) => r[1] > 0);
  const aimed = first.filter(([t]) => want.includes(Number(t)));
  if (aimed.length && rnd() < 0.8) first = aimed;
  if (!first.length) return null;
  const [t1, r1] = pick(first);
  const lo1 = Math.max(1, r1[0]);
  const sk = [[Number(t1), lo1 + int(Math.max(1, r1[1] - lo1 + 1))]];
  if (rnd() < 0.5) {
    const second = Object.entries(table).filter(([t, r]) => r[3] > 0 && Number(t) !== Number(t1));
    if (second.length) {
      const [t2, r2] = pick(second);
      const lo2 = Math.max(1, r2[2]);
      sk.push([Number(t2), lo2 + int(Math.max(1, r2[3] - lo2 + 1))]);
    }
  }
  const tal = { rar, slots: int(4), sk };
  return E.validateTalisman(tal, charm, data.skills).length ? null : tal;
}

const TRIALS = Number(process.argv[3] || 200);
const name = t => data.skills.trees[t];
let ran = 0, miss = 0, thin = 0, slowest = 0;

for (let i = 0; i < TRIALS * 12 && ran < TRIALS; i++) {
  const gender = int(2), cls = rnd() < 0.5 ? "B" : "G", ws = int(4);
  const want = [];
  while (want.length < 3 + int(3)) { const t = pick(TREES); if (!want.includes(t)) want.push(t); }

  const pieces = {}, running = {};
  for (const s of SLOTS) {
    const pool = Object.entries(data.armor[s]).map(([id, a]) => ({ id: Number(id), a }))
      .filter(({ a }) => (a.gender === 2 || a.gender === gender) && (a.cls === "A" || a.cls === cls));
    const ranked = pool.map(c => ({ c, k: ptsIn(c.a.sk, want) + c.a.slots }))
      .sort((x, y) => y.k - x.k).slice(0, 40).map(x => x.c);
    const c = pick(ranked.length ? ranked : pool);
    for (const [t, p] of c.a.sk) running[t] = (running[t] || 0) + p;
    pieces[s] = { id: c.id, decos: gemSlot(c.a.slots, want, running) };
  }
  const tal = randomTalisman(want);
  if (!tal) continue;
  tal.decos = gemSlot(tal.slots, want, running);
  const r = E.compute({ pieces, talisman: tal, weapon: { slots: ws, decos: gemSlot(ws, want, running) } }, data);
  if (r.problems.length) continue;

  // Everything the witness genuinely has, Soul grants included.
  const byTree = new Map();
  for (const a of r.active.concat(r.soulGrants))
    if (!a.negative && data.skills.active[a.tree])
      byTree.set(a.tree, Math.max(byTree.get(a.tree) || 0, a.threshold));
  const all = [...byTree.entries()];
  if (all.length < 3) { thin++; continue; }
  const bag = all.slice(), targets = [];
  for (let k = 0, n = Math.min(all.length, 3 + int(4)); k < n && bag.length; k++)
    targets.push(...bag.splice(int(bag.length), 1));

  ran++;
  const t0 = Date.now();
  const res = S.search({ targets, gender, cls, maxRar: 11, weaponSlots: ws,
    talismans: [tal], maxResults: 3, timeBudgetMs: 60000 }, data);
  const ms = Date.now() - t0;
  if (ms > slowest) slowest = ms;
  if (res.results.length) continue;

  miss++;
  console.error(`MISS #${miss}  gender ${gender} ${cls} ${ws} weapon slots  ${ms} ms  complete=${res.complete}`);
  console.error("   asked for:", targets.map(([t, p]) => `${name(t)}@${p}`).join(", "));
  console.error("   witness:  ", SLOTS.map(s => data.armor[s][pieces[s].id].n).join(" / "));
  console.error("   charm:    ", `R${tal.rar} ${tal.slots}sl ` + tal.sk.map(([t, p]) => `${name(t)}+${p}`).join(", "));
  console.error("   repro:    ", JSON.stringify({ gender, cls, ws, targets, tal, pieces }));
}

console.log(`${ran} trials, ${miss} miss(es), slowest ${slowest} ms `
  + `(${thin} witnesses activated too few skills to make a query)`);
process.exit(miss ? 1 : 0);
