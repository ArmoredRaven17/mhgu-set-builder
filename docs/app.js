/* MHGU Set Builder — state, persistence, wiring.
 *
 * Save model (matches the Equipment Box's): one shared document lives in
 * localStorage under the Collection Tracker's key, and this app owns only its
 * `sets` section — everything else is read back immediately before every write
 * so the other apps' halves are never clobbered from a stale copy. A save file
 * is either a tracker envelope (rewritten whole, only `sets` replaced) or this
 * app's own standalone format.
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const UI = window.SBUI, Pickers = window.SBPickers, Engine = window.SBEngine;

  const SAVE_APP = "mhgu-set-builder";
  const SAVE_VERSION = 1;
  const TRACKER_APP = "mhgu-collection-tracker";
  const SETS_KEY = "sets";
  const AUTOSAVE_KEY = "mhgu-tracker-autosave";   // legacy name, shared contents
  const LOCAL_ENABLED_KEY = "mhgu-sets-local";
  const DATA_VERSION = "1";
  const SLOTS = UI.SLOTS;

  const DATA = {
    skills: window.SB_SKILLS, souls: window.SB_SOULS,
    decos: window.SB_DECOS, armor: window.SB_ARMOR,
  };

  // ── State ──────────────────────────────────────────────────────────────
  const newSet = name => ({
    name: name || "New Set",
    weapon: null,                     // { cls, id, lv, decos: [] }
    pieces: { head: null, chest: null, arms: null, waist: null, legs: null },
    talisman: null,                   // { tier, slots, sk: [[tree,pts],...], decos: [] }
  });
  let sets = { version: 1, active: 0, list: [newSet("Set 1")] };
  let host = null;          // tracker-file envelope (minus `sets`) when hosted
  let fileHandle = null;
  let dirty = false;
  let localSaveEnabled = true;
  try { localSaveEnabled = localStorage.getItem(LOCAL_ENABLED_KEY) !== "0"; } catch (e) {}

  const currentSet = () => sets.list[sets.active] || sets.list[0];

  // ── Theme ──────────────────────────────────────────────────────────────
  // Same palette and derivation as the Collection Tracker and Equipment Box,
  // so the family sits together. Only the storage key is this app's own.
  const THEME_KEY = "mhgu-sets-theme";
  const THEME_COLORS = [
    ["Teostra", "#570B0B"], ["Rathalos", "#b51717"],
    ["Tetsucabra", "#68360D"], ["Agnaktor", "#B5590D"],
    ["Tigrex", "#574916"], ["Rajang", "#9C8328"],
    ["Deviljho", "#0B570F"], ["Rathian", "#39993E"],
    ["Astalos", "#14503d"], ["Zinogre", "#279773"],
    ["Zamtrios", "#005984"], ["Plesioth", "#0080c1"],
    ["Brachydios", "#0B2757"], ["Lagiacrus", "#0b3f97"],
    ["G. Magala", "#1F0B57", "Gore Magala"], ["Nerscylla", "#4e2fa2"],
    ["Y. Garuga", "#62008f", "Yian Garuga"], ["Chameleos", "#8e50ab"],
    ["Mizutsune", "#D4358C"], ["Congalala", "#C8679D"],
    ["Duramboros", "#5a411f"], ["Diablos", "#997c54"],
    ["Barroth", "#835A32"], ["Bulldrome", "#B17A47"],
    ["K. Daora", "#505358", "Kushala Daora"], ["Valstrax", "#7C879B"],
    ["Forbidden", "#1E2025", "Question Mark"],
  ];
  // THE PALETTE'S ONE INVARIANT: every theme takes white text and a white checkbox tick.
  //
  // Both come off the same number. A native checkbox takes accent-color from the theme and the
  // browser picks the tick glyph itself — white below relative luminance .1791, black above it —
  // and applyTheme picks the text direction the same way, light text while the draw block's
  // ground sits under that same .1791. The ground is the lighter of the two surfaces (a 60/40
  // composite of darken(hex,.80) and darken(hex,.95), against the tick's darken(hex,.70)), so it
  // is strictly the binding one: hold the ground under the line and the tick follows for free.
  //
  // Every theme is under it now, so the light-text branch never fires and no theme renders the
  // other way round from the rest. Worst white-on-ground in the palette is 4.73:1, clearing AA.
  // The one exemption is the Quest Randomizer's Gypceros, a white gag theme whose whole joke is
  // tripping the light branch; it is not in this list anywhere else.
  //
  // A NEW OR RE-CUT COLOUR HAS TO CLEAR THIS. A swatch that fails is not a slightly-too-bright
  // swatch, it is a theme that inverts against every other one.
  //
  // Eight came down to get there — Rajang, Rathian, Zinogre, Mizutsune, Congalala, Barroth,
  // Bulldrome and Valstrax — by lightness alone, so each keeps its own hue and saturation. Where
  // capping the light member on its own would have squashed a pair onto one lightness, the dark
  // partner came down by the same factor instead of the pair collapsing: that is why Barroth
  // moved with Bulldrome, and Mizutsune with Congalala.
  //
  // Two pairs are re-cuts of other pairs, keeping their own slot on the wheel and taking the
  // source pair's saturation and lightness, member for member:
  //
  //   Tigrex / Rajang        <- Astalos / Zinogre,      at the yellow slot (47°)
  //   Tetsucabra / Agnaktor  <- Brachydios / Lagiacrus, at the orange slot (27°), both lifted 20%
  //
  // The earth tones (Duramboros, Diablos, Barroth, Bulldrome) share the 27–47° stretch with both
  // of those pairs by design. Swatches sitting close together in there is expected and is not a
  // collision to design out.
  //
  // A saved theme is a bare hex, so anyone sitting on a retired one keeps a colour that is no
  // longer in the list: it never picks up the change, and anything keyed off the hex (the selected
  // swatch, the theme's icon) stops matching. Remap on read, not on write — the stale value is
  // already in localStorage on every device that chose it. Only hexes that actually shipped are
  // listed; cuts that never left the working tree are not, because no device can hold them. The
  // map is kept identical in all nine apps regardless of which app released what, because this
  // palette is hand-copied with no shared source.
  const LEGACY_HEX = {
    "#C8A319": "#574916", "#57470B": "#574916", "#5E4D0C": "#574916",           // Tigrex
    "#F1D364": "#9C8328", "#B59417": "#9C8328", "#C39F19": "#9C8328",           // Rajang
    "#BEA031": "#9C8328",
    "#C65900": "#68360D", "#FC933E": "#B5590D",                                 // Tetsucabra, Agnaktor
    "#3A9B3F": "#39993E", "#2DAE85": "#279773",                                 // Rathian, Zinogre
    "#D84696": "#D4358C", "#CE79A8": "#C8679D",                                 // Mizutsune, Congalala
    "#B57C45": "#835A32", "#CFAA87": "#B17A47",                                 // Barroth, Bulldrome
    "#AEB5C1": "#7C879B",                                                       // Valstrax
  };
  const migrateHex = (h) => (h && LEGACY_HEX[h.toUpperCase()]) || h;
  const COLORS_HEX = Object.fromEntries(THEME_COLORS.map(([name, hex]) => [hex.toUpperCase(), name]));
  const COLORS_ICON = Object.fromEntries(THEME_COLORS.filter(c => c[2]).map(([name, , icon]) => [name, icon]));
  const FALLBACK_ICON = "assets/MonsterIcons/MHGU-Question_Mark_Icon.webp";
  const monsterIcon = name => name ? "assets/MonsterIcons/MHGU-" + name.replace(/ /g, "_") + "_Icon.webp" : FALLBACK_ICON;

  const hexRgb = h => { h = h.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); };
  const clampC = n => Math.max(0, Math.min(255, Math.round(n)));
  const clamp01 = n => Math.max(0, Math.min(1, n));
  const rgbToHsl = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    if (d === 0) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
    return [h, s, l];
  };
  const hslToRgb = ([h, s, l]) => {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h * 6) % 2 - 1)), m = l - c / 2;
    const hi = Math.floor(h * 6) % 6;
    const [r, g, b] = hi === 0 ? [c, x, 0] : hi === 1 ? [x, c, 0] : hi === 2 ? [0, c, x]
      : hi === 3 ? [0, x, c] : hi === 4 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m].map(v => clampC(v * 255));
  };
  const darken = (rgb, f) => { const [h, s, l] = rgbToHsl(rgb); return hslToRgb([h, s, clamp01(l * f)]); };
  const lighten = (rgb, b) => { const [h, s, l] = rgbToHsl(rgb); return hslToRgb([h, s, clamp01(l + (1 - l) * b)]); };
  const cssRgb = rgb => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

  function applyTheme(hex) {
    const c = hexRgb(hex), r = document.documentElement.style;
    r.setProperty("--bg", cssRgb(darken(c, .70)));
    r.setProperty("--bg1", cssRgb(darken(c, .80)));
    r.setProperty("--grid-bg", cssRgb(darken(c, .35)));
    r.setProperty("--content-bg", cssRgb(darken(c, .55)));
    r.setProperty("--panel-bg", cssRgb(darken(c, .40)));
    r.setProperty("--bg2", cssRgb(darken(c, .95)));
    r.setProperty("--nav-bg", cssRgb(darken(c, .85)));
    // Control factors measured across all 27 themes in the Equipment Box —
    // see the long note there. .42 is the contrast ceiling for a white label.
    r.setProperty("--control-bg", cssRgb(darken(c, .34)));
    r.setProperty("--control-bg-hover", cssRgb(darken(c, .42)));
    r.setProperty("--control-active", cssRgb(darken(c, .24)));
    r.setProperty("--accent", cssRgb(darken(c, .7)));
    r.setProperty("--accent-hover", cssRgb(lighten(c, .4)));
    try { localStorage.setItem(THEME_KEY, hex); } catch (e) {}
    document.querySelectorAll(".swatch").forEach(s => s.classList.toggle("sel", s.dataset.hex === hex));
    // The title icon follows the theme — the monster the colour is named after.
    const titleIcon = document.querySelector(".title-icon");
    if (titleIcon) {
      const name = COLORS_HEX[hex.toUpperCase()];
      titleIcon.src = name ? monsterIcon(COLORS_ICON[name] || name) : FALLBACK_ICON;
    }
  }
  function buildSwatches() {
    const wrap = $("swatches");
    wrap.innerHTML = "";
    for (const [name, hex, iconOverride] of THEME_COLORS) {
      const d = document.createElement("div");
      d.className = "swatch";
      d.dataset.hex = hex;
      d.style.background = hex;
      d.title = name;
      d.innerHTML = `<img class="swatch-icon" src="${monsterIcon(iconOverride || name)}" alt=""><span>${name}</span>`;
      d.addEventListener("click", () => applyTheme(hex));
      wrap.appendChild(d);
    }
  }

  // ── Weapon data (lazy per class) ───────────────────────────────────────
  const weaponCache = new Map();
  function weaponData(cls) {
    if (weaponCache.has(cls)) return weaponCache.get(cls);
    const p = fetch(`data/weapons/${cls}.json?v=${DATA_VERSION}`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)));
    weaponCache.set(cls, p);
    p.catch(() => weaponCache.delete(cls));
    return p;
  }

  // ── Dirty / autosave ───────────────────────────────────────────────────
  function markDirty() {
    if (!dirty) { dirty = true; $("dirtyDot").classList.remove("hidden"); document.title = "● MHGU Set Builder"; }
    scheduleAutosave();
  }
  function clearDirty() { dirty = false; $("dirtyDot").classList.add("hidden"); document.title = "MHGU Set Builder"; }

  const readStored = key => {
    let raw;
    try { raw = localStorage.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };
  let autosaveTimer = null;
  function scheduleAutosave() {
    if (!localSaveEnabled) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(flushAutosave, 500);
  }
  // Read-modify-write the shared document: only the sets section is ours.
  function flushAutosave() {
    if (!localSaveEnabled) return;
    let doc = readStored(AUTOSAVE_KEY);
    if (!doc || typeof doc !== "object")
      doc = { app: TRACKER_APP, version: 2, owned: { w: {}, a: {}, p: {} }, levels: { w: {}, a: {}, p: {} } };
    doc[SETS_KEY] = sectionPayload();
    doc.savedAt = new Date().toISOString();
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc)); } catch (e) {}
  }
  // Drop only our section; delete the key only if nothing else lives there.
  function clearLocalSave() {
    clearTimeout(autosaveTimer);
    const doc = readStored(AUTOSAVE_KEY);
    try {
      if (doc && typeof doc === "object") {
        delete doc[SETS_KEY];
        const meaningful = Object.keys(doc).some(k => !["app", "version", "savedAt"].includes(k));
        if (meaningful) localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc));
        else localStorage.removeItem(AUTOSAVE_KEY);
      }
    } catch (e) {}
  }

  // ── Save / load ────────────────────────────────────────────────────────
  const sectionPayload = () => ({ version: sets.version, active: sets.active, list: sets.list });
  function serializeSave() {
    if (host) {
      const out = Object.assign({}, host);
      out[SETS_KEY] = sectionPayload();
      out.savedAt = new Date().toISOString();
      return out;
    }
    return { app: SAVE_APP, version: SAVE_VERSION, savedAt: new Date().toISOString(), [SETS_KEY]: sectionPayload() };
  }
  const isTrackerFile = obj => !!obj && typeof obj === "object" && obj.app === TRACKER_APP;
  function validateSave(obj) {
    if (!obj || typeof obj !== "object") return "Not a valid file.";
    if (obj.app !== SAVE_APP && !isTrackerFile(obj))
      return "This file isn't an MHGU Set Builder or Collection Tracker save.";
    if (obj.app === SAVE_APP && (!Number.isInteger(obj.version) || obj.version > SAVE_VERSION))
      return "This save was made with a newer version.";
    const s = obj[SETS_KEY];
    if (s == null) return isTrackerFile(obj) ? null : "Save file contains no sets.";
    if (typeof s !== "object" || !Array.isArray(s.list)) return "Set data is malformed.";
    return null;
  }
  // Sanitize a stored set against the current data tables; anything broken is
  // dropped rather than crashing the render.
  function sanitizeSet(raw) {
    if (!raw || typeof raw !== "object") return null;
    const s = newSet(typeof raw.name === "string" && raw.name.trim() ? raw.name : "Set");
    const decoList = d => (Array.isArray(d) ? d.filter(id => window.SB_DECOS[id]) : []);
    if (raw.weapon && typeof raw.weapon === "object" && window.SB_WEAPONS.index[raw.weapon.cls]
        && window.SB_WEAPONS.index[raw.weapon.cls].some(e => e[0] === raw.weapon.id)) {
      s.weapon = { cls: raw.weapon.cls, id: raw.weapon.id, lv: Number(raw.weapon.lv) || 1, decos: decoList(raw.weapon.decos) };
    }
    if (raw.pieces && typeof raw.pieces === "object") {
      for (const slot of SLOTS) {
        const p = raw.pieces[slot];
        if (p && typeof p === "object" && window.SB_ARMOR[slot][p.id])
          s.pieces[slot] = { id: Number(p.id), lv: Number(p.lv) || 0, decos: decoList(p.decos) };
      }
    }
    const t = raw.talisman;
    if (t && typeof t === "object") {
      // Saves from before the rarity model stored a tier name; map those to a
      // representative rarity of the same tier.
      const LEGACY_TIER_RAR = { mystery: 1, shining: 3, timeworn: 5, enduring: 8 };
      const rar = Number.isInteger(t.rar) ? t.rar : LEGACY_TIER_RAR[t.tier];
      if (rar >= 1 && rar <= 10) {
        const sk = (Array.isArray(t.sk) ? t.sk : []).slice(0, 2)
          .filter(e => Array.isArray(e) && window.SB_SKILLS.trees[e[0]] && Number.isInteger(e[1]))
          .map(e => [Number(e[0]), Number(e[1])]);
        if (sk.length) s.talisman = { rar, slots: Math.min(Math.max(Number(t.slots) || 0, 0), 3), sk, decos: decoList(t.decos), gen: !!t.gen };
      }
    }
    return s;
  }
  function applySave(obj, opts) {
    const section = obj[SETS_KEY];
    if (!opts || opts.adopt !== false) {
      if (isTrackerFile(obj)) { host = Object.assign({}, obj); delete host[SETS_KEY]; }
      else host = null;
    }
    const list = section && Array.isArray(section.list) ? section.list.map(sanitizeSet).filter(Boolean) : [];
    sets = {
      version: 1,
      active: section && Number.isInteger(section.active) ? section.active : 0,
      list: list.length ? list : [newSet("Set 1")],
    };
    if (sets.active < 0 || sets.active >= sets.list.length) sets.active = 0;
    renderSetSelect();
    render();
    scheduleAutosave();
  }

  const supportsFsApi = "showSaveFilePicker" in window;
  const saveName = () => (host ? "mhgu-collection.json" : "mhgu-sets.json");
  const saveOpts = () => ({ suggestedName: saveName(), types: [{ description: "JSON", accept: { "application/json": [".json"] } }] });
  async function saveToFile(forceNew) {
    const data = JSON.stringify(serializeSave(), null, 2);
    if (supportsFsApi) {
      try {
        if (forceNew || !fileHandle) fileHandle = await window.showSaveFilePicker(saveOpts());
        const w = await fileHandle.createWritable(); await w.write(data); await w.close();
        clearDirty(); UI.toast("Saved."); return;
      } catch (e) { if (e && e.name === "AbortError") return; }
    }
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = saveName(); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    clearDirty(); UI.toast("Downloaded save file.");
  }
  function loadFromText(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { UI.toast("That file isn't valid JSON."); return; }
    const err = validateSave(obj);
    if (err) { UI.toast(err); return; }
    applySave(obj);
    clearDirty();
    UI.toast(host ? "Loaded sets from a shared collection file." : "Loaded.");
  }
  async function openFile() {
    if (supportsFsApi) {
      try {
        const [h] = await window.showOpenFilePicker({ types: saveOpts().types });
        fileHandle = h;
        const f = await h.getFile();
        loadFromText(await f.text());
        return;
      } catch (e) { if (e && e.name === "AbortError") return; }
    }
    $("importFile").click();
  }

  // ── Mutation API (handed to the pickers and cards) ─────────────────────
  function update(fn) {
    fn(currentSet());
    markDirty();
    render();
  }
  function freeSlots(target) {
    const set = currentSet();
    if (target.kind === "weapon") {
      const st = resolved.weaponStat;
      return st ? st.slots - Engine.decoCost(set.weapon.decos, DATA) : 0;
    }
    if (target.kind === "talisman")
      return set.talisman ? set.talisman.slots - Engine.decoCost(set.talisman.decos, DATA) : 0;
    const p = set.pieces[target.slot];
    const a = p && window.SB_ARMOR[target.slot][p.id];
    return a ? a.slots - Engine.decoCost(p.decos, DATA) : 0;
  }
  const decosOf = (set, target) =>
    target.kind === "weapon" ? set.weapon.decos :
    target.kind === "talisman" ? set.talisman.decos :
    set.pieces[target.slot].decos;
  // Which armor class the selected weapon implies: "G" for the three gunner
  // weapons, "B" for the rest, null with no weapon.
  const GUNNER_CLASSES = new Set(["bow", "light_bowgun", "heavy_bowgun"]);
  const weaponArmorClass = () => {
    const w = currentSet().weapon;
    return w ? (GUNNER_CLASSES.has(w.cls) ? "G" : "B") : null;
  };
  const api = {
    freeSlots,
    weaponArmorClass,
    setPiece: (slot, id) => update(s => { s.pieces[slot] = { id, lv: 0, decos: [] }; }),
    clearPiece: slot => update(s => { s.pieces[slot] = null; }),
    setPieceLevel: (slot, lv) => update(s => { if (s.pieces[slot]) s.pieces[slot].lv = lv; }),
    setWeapon: (cls, id) => update(s => {
      const entry = window.SB_WEAPONS.index[cls].find(e => e[0] === id);
      s.weapon = { cls, id, lv: entry ? entry[4] : 1, decos: [] };
    }),
    clearWeapon: () => update(s => { s.weapon = null; }),
    setWeaponLevel: lv => update(s => { if (s.weapon) { s.weapon.lv = lv; s.weapon.decos = []; } }),
    setTalismanRarity: rar => update(s => {
      if (!rar) { s.talisman = null; return; }
      const old = s.talisman;
      s.talisman = { rar, slots: old ? old.slots : 0, sk: [], decos: old ? old.decos : [] };
      // Keep the old skills where the new rarity's tier can roll them, clamped.
      const table = window.SB_CHARM.tiers[Engine.TAL_TIER[rar]];
      const keep = [];
      for (let i = 0; i < (old ? old.sk.length : 0); i++) {
        const [tree, pts] = old.sk[i];
        const row = table[tree];
        const [lo, hi] = i === 0 ? [row && row[0], row && row[1]] : [row && row[2], row && row[3]];
        if (row && (lo !== 0 || hi !== 0)) keep.push([tree, Math.min(Math.max(pts, lo), hi)]);
      }
      if (!keep.length) {
        const first = Object.keys(table).map(Number).find(tr => table[tr][0] !== 0 || table[tr][1] !== 0);
        keep.push([first, table[first][0]]);
      }
      s.talisman.sk = keep;
    }),
    setTalismanSkill: (i, tree) => update(s => {
      const t = s.talisman; if (!t) return;
      const table = window.SB_CHARM.tiers[Engine.TAL_TIER[t.rar]];
      if (tree == null) { t.sk = t.sk.slice(0, 1); return; }
      const row = table[tree] || [0, 0, 0, 0];
      const [lo, hi] = i === 0 ? [row[0], row[1]] : [row[2], row[3]];
      t.sk[i] = [tree, Math.min(Math.max(t.sk[i] ? t.sk[i][1] : lo, lo), hi)];
    }),
    setTalismanPoints: (i, pts) => update(s => {
      const t = s.talisman; if (!t || !t.sk[i]) return;
      const row = window.SB_CHARM.tiers[Engine.TAL_TIER[t.rar]][t.sk[i][0]] || [0, 0, 0, 0];
      const [lo, hi] = i === 0 ? [row[0], row[1]] : [row[2], row[3]];
      t.sk[i][1] = Math.min(Math.max(pts, lo), hi);
    }),
    setTalismanSlots: n => update(s => { if (s.talisman) s.talisman.slots = n; }),
    addDeco: (target, id) => update(s => { decosOf(s, target).push(id); }),
    removeDeco: (target, i) => update(s => { decosOf(s, target).splice(i, 1); }),
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const resolved = { weaponLevels: null, weaponStat: null };
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const set = currentSet();
    resolved.weaponLevels = null;
    resolved.weaponStat = null;
    let weapon = null;
    if (set.weapon) {
      try {
        const wd = await weaponData(set.weapon.cls);
        if (seq !== renderSeq) return;   // superseded while fetching
        const levels = wd.byId[set.weapon.id] || [];
        const st = levels.find(l => l.lv === set.weapon.lv) || levels[levels.length - 1];
        if (st) {
          resolved.weaponLevels = levels;
          resolved.weaponStat = st;
          weapon = { slots: st.slots, def: st.def, decos: set.weapon.decos };
        }
      } catch (e) { UI.toast("Couldn't load weapon data."); }
    }
    UI.renderCards(set, resolved, api);
    const build = { weapon, pieces: set.pieces, talisman: set.talisman };
    UI.renderResults(Engine.compute(build, DATA), set);
  }

  // ── Set management ─────────────────────────────────────────────────────
  function renderSetSelect() {
    const sel = $("setSelect");
    sel.innerHTML = sets.list.map((s, i) =>
      `<option value="${i}"${i === sets.active ? " selected" : ""}>${Pickers.esc(s.name)}</option>`).join("");
  }
  function wireHeader() {
    $("setSelect").addEventListener("change", e => {
      sets.active = Number(e.target.value);
      markDirty(); render();
    });
    $("setNew").addEventListener("click", () => {
      sets.list.push(newSet(`Set ${sets.list.length + 1}`));
      sets.active = sets.list.length - 1;
      renderSetSelect(); markDirty(); render();
    });
    $("setDup").addEventListener("click", () => {
      const copy = JSON.parse(JSON.stringify(currentSet()));
      copy.name += " (copy)";
      sets.list.splice(sets.active + 1, 0, copy);
      sets.active++;
      renderSetSelect(); markDirty(); render();
    });
    $("setRename").addEventListener("click", () => {
      const name = prompt("Set name:", currentSet().name);
      if (name && name.trim()) { currentSet().name = name.trim(); renderSetSelect(); markDirty(); }
    });
    $("setDelete").addEventListener("click", () => {
      UI.confirmDialog("Delete set", `<p>Delete “${Pickers.esc(currentSet().name)}”?</p>`, () => {
        sets.list.splice(sets.active, 1);
        if (!sets.list.length) sets.list.push(newSet("Set 1"));
        sets.active = Math.min(sets.active, sets.list.length - 1);
        renderSetSelect(); markDirty(); render();
      });
    });
    $("saveBtn").addEventListener("click", () => saveToFile(false));
    $("saveAsBtn").addEventListener("click", () => saveToFile(true));
    $("openBtn").addEventListener("click", openFile);
    $("shareBtn").addEventListener("click", shareCurrent);
    $("importFile").addEventListener("change", async e => {
      const f = e.target.files[0];
      if (f) loadFromText(await f.text());
      e.target.value = "";
    });
    for (const [btn, modal] of [["settingsBtn", "settingsModal"], ["linksBtn", "linksModal"], ["aboutBtn", "aboutModal"]]) {
      $(btn).addEventListener("click", () => $(modal).classList.remove("hidden"));
    }
    for (const [btn, modal] of [["settingsClose", "settingsModal"], ["linksClose", "linksModal"], ["aboutClose", "aboutModal"]]) {
      $(btn).addEventListener("click", () => $(modal).classList.add("hidden"));
    }
    for (const modal of ["settingsModal", "linksModal", "aboutModal"]) {
      $(modal).addEventListener("mousedown", e => { if (e.target === $(modal)) $(modal).classList.add("hidden"); });
    }
    const toggle = $("localSaveToggle");
    const syncToggle = () => toggle.setAttribute("aria-checked", String(localSaveEnabled));
    toggle.addEventListener("click", () => {
      localSaveEnabled = !localSaveEnabled;
      try { localStorage.setItem(LOCAL_ENABLED_KEY, localSaveEnabled ? "1" : "0"); } catch (e) {}
      if (localSaveEnabled) scheduleAutosave(); else clearLocalSave();
      syncToggle();
    });
    syncToggle();
    $("clearLocalBtn").addEventListener("click", () => {
      UI.confirmDialog("Clear browser save", "<p>Remove the sets stored in this browser? Other apps' data in the shared save is kept.</p>", () => {
        clearLocalSave(); UI.toast("Browser save cleared.");
      });
    });
  }

  // ── Sharing ────────────────────────────────────────────────────────────
  // A set travels in the link's hash, so it works on a static host and never
  // reaches a server. Opening one adds it as a new set rather than touching
  // anything the recipient already has.
  function shareCurrent() {
    const link = window.SBShare.linkFor(currentSet());
    const done = () => UI.toast("Link copied — it contains the whole set.");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(done, () => prompt("Copy this link:", link));
    } else {
      prompt("Copy this link:", link);
    }
  }
  function openSharedFromHash() {
    const shared = window.SBShare.fromHash(location.hash, DATA);
    if (!shared) return false;
    // Clear the hash first, so a reload does not add the set a second time.
    history.replaceState(null, "", location.pathname + location.search);
    sets.list.push(shared);
    sets.active = sets.list.length - 1;
    renderSetSelect();
    render();
    markDirty();
    UI.toast(`Opened “${shared.name}”.`);
    return true;
  }

  // ── Startup ────────────────────────────────────────────────────────────
  Pickers.init();
  wireHeader();
  buildSwatches();
  let savedTheme = "#1E2025";
  try { savedTheme = migrateHex(localStorage.getItem(THEME_KEY)) || savedTheme; } catch (e) {}
  applyTheme(savedTheme);
  const stored = readStored(AUTOSAVE_KEY);
  if (stored && stored[SETS_KEY]) applySave(stored, { adopt: false });
  else { renderSetSelect(); render(); }
  openSharedFromHash();
  // Pasting a link into an already-open builder only changes the hash, which
  // does not reload the page — so listen for that too.
  window.addEventListener("hashchange", openSharedFromHash);
  window.addEventListener("beforeunload", () => { if (localSaveEnabled && dirty) flushAutosave(); });
})();
