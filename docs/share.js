// share.js — a whole set in a URL.
//
// There is no server behind this app, so a shared set has to travel inside the
// link itself. It rides in the hash, which the browser never sends anywhere:
// the person you send it to gets the set, and nobody else sees it in a log.
//
// The payload is bit-packed and then base64url-encoded, so the link contains
// only letters, digits, `-` and `_`. That matters for where these get pasted:
// the first version used `~` `,` `:` as separators and chat clients cut the
// link at the first comma, leaving people with a dead link. A single opaque
// token also reads as an ordinary share link rather than something suspicious.
//
// Field widths come from the data rather than guesswork — armor ids reach
// 1286, weapon ids 136, decoration ids 2888, skill trees 205, armor levels 15:
//
//   version   4 bits (2)
//   weapon    1 present, then class 4, id 8, level 4, count 2, decos 12 each
//   5 slots   1 present, then id 11, level 4, count 2, decos 12 each
//   talisman  1 present, then rarity 4, slots 2, skills 2,
//             per skill tree 8 and points 7 (offset by 32 to carry a malus),
//             then count 2 and decos 12 each
//   name      6 bits of length, then UTF-8 bytes
//
// A full set lands around 44 bytes — about 60 characters of base64url.
//
// Version 1 links (`1~name~…`) are still read, so anything already shared keeps
// working.
window.SBShare = (function () {
  "use strict";
  const VERSION = 2;
  const SLOTS = ["head", "chest", "arms", "waist", "legs"];
  const PTS_OFFSET = 32;          // talisman points can be negative
  const MAX_NAME = 63;            // 6 bits of length

  // Weapon classes are stored as an index, so the list's order is part of the
  // format: append only, never reorder.
  const CLASSES = ["great_sword", "long_sword", "sword_and_shield", "dual_blades",
    "hammer", "hunting_horn", "lance", "gunlance", "switch_axe", "charge_blade",
    "insect_glaive", "light_bowgun", "heavy_bowgun", "bow"];

  // ── bit IO ─────────────────────────────────────────────────────────────
  function Writer() {
    const bytes = [];
    let cur = 0, used = 0;
    return {
      put(value, width) {
        for (let i = width - 1; i >= 0; i--) {
          cur = (cur << 1) | ((value >> i) & 1);
          if (++used === 8) { bytes.push(cur); cur = 0; used = 0; }
        }
      },
      finish() {
        if (used) bytes.push(cur << (8 - used));
        return bytes;
      },
    };
  }
  function Reader(bytes) {
    let pos = 0;
    return {
      get(width) {
        let v = 0;
        for (let i = 0; i < width; i++) {
          const byte = bytes[pos >> 3];
          if (byte === undefined) throw new Error("truncated");
          v = (v << 1) | ((byte >> (7 - (pos & 7))) & 1);
          pos++;
        }
        return v;
      },
      left() { return bytes.length * 8 - pos; },
    };
  }

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function toBase64url(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      const take = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
      for (let j = 0; j < take; j++) out += B64[(n >> (18 - j * 6)) & 63];
    }
    return out;
  }
  function fromBase64url(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i += 4) {
      let n = 0, take = 0;
      for (let j = 0; j < 4; j++) {
        const idx = B64.indexOf(str[i + j]);
        if (idx < 0) break;
        n = (n << 6) | idx;
        take++;
      }
      if (take < 2) break;
      n <<= 6 * (4 - take);
      for (let j = 0; j < take - 1; j++) bytes.push((n >> (16 - j * 8)) & 255);
    }
    return bytes;
  }

  // ── encode ─────────────────────────────────────────────────────────────
  function encode(set) {
    const w = new Writer();
    w.put(VERSION, 4);

    const wp = set.weapon;
    const cls = wp ? CLASSES.indexOf(wp.cls) : -1;
    if (wp && cls >= 0) {
      w.put(1, 1);
      w.put(cls, 4);
      w.put(Math.min(wp.id || 0, 255), 8);
      w.put(Math.min(wp.lv || 1, 15), 4);
      const d = (wp.decos || []).slice(0, 3);
      w.put(d.length, 2);
      for (const id of d) w.put(Math.min(id, 4095), 12);
    } else w.put(0, 1);

    for (const slot of SLOTS) {
      const p = set.pieces[slot];
      if (!p) { w.put(0, 1); continue; }
      w.put(1, 1);
      w.put(Math.min(p.id || 0, 2047), 11);
      w.put(Math.min(p.lv || 0, 15), 4);
      const d = (p.decos || []).slice(0, 3);
      w.put(d.length, 2);
      for (const id of d) w.put(Math.min(id, 4095), 12);
    }

    const t = set.talisman;
    if (t) {
      w.put(1, 1);
      w.put(Math.min(Math.max(t.rar || 1, 1), 15), 4);
      w.put(Math.min(t.slots || 0, 3), 2);
      const sk = (t.sk || []).slice(0, 3);
      w.put(sk.length, 2);
      for (const [tree, pts] of sk) {
        w.put(Math.min(tree, 255), 8);
        w.put(Math.min(Math.max(pts + PTS_OFFSET, 0), 127), 7);
      }
      const d = (t.decos || []).slice(0, 3);
      w.put(d.length, 2);
      for (const id of d) w.put(Math.min(id, 4095), 12);
    } else w.put(0, 1);

    const name = new TextEncoder().encode((set.name || "").slice(0, MAX_NAME));
    const n = name.slice(0, MAX_NAME);
    w.put(n.length, 6);
    for (const b of n) w.put(b, 8);

    return toBase64url(w.finish());
  }

  // ── decode ─────────────────────────────────────────────────────────────
  // Every id is checked against the real data; anything that does not resolve
  // is dropped rather than guessed at, so a mangled link degrades to a partial
  // set instead of a broken page.
  function decodeV2(str, data) {
    let r;
    try { r = Reader(fromBase64url(str)); } catch (e) { return null; }
    try {
      if (r.get(4) !== VERSION) return null;
      const set = { name: "Shared set", weapon: null, pieces: {}, talisman: null };
      for (const slot of SLOTS) set.pieces[slot] = null;
      const decos = n => {
        const out = [];
        for (let i = 0; i < n; i++) {
          const id = r.get(12);
          if (data.decos[id]) out.push(id);
        }
        return out;
      };

      if (r.get(1)) {
        const cls = CLASSES[r.get(4)], id = r.get(8), lv = r.get(4);
        const d = decos(r.get(2));
        const index = window.SB_WEAPONS && window.SB_WEAPONS.index && window.SB_WEAPONS.index[cls];
        if (index && index.some(e => e[0] === id)) set.weapon = { cls, id, lv: lv || 1, decos: d };
      }
      for (const slot of SLOTS) {
        if (!r.get(1)) continue;
        const id = r.get(11), lv = r.get(4);
        const d = decos(r.get(2));
        if (data.armor[slot][id]) set.pieces[slot] = { id, lv, decos: d };
      }
      if (r.get(1)) {
        const rar = r.get(4), slots = r.get(2), nsk = r.get(2);
        const sk = [];
        for (let i = 0; i < nsk; i++) {
          const tree = r.get(8), pts = r.get(7) - PTS_OFFSET;
          if (data.skills.trees[tree]) sk.push([tree, pts]);
        }
        const d = decos(r.get(2));
        if (rar >= 1 && rar <= 10) set.talisman = { rar, slots, sk, decos: d };
      }
      const len = r.get(6);
      if (len && r.left() >= len * 8) {
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = r.get(8);
        const name = new TextDecoder().decode(bytes).trim();
        if (name) set.name = name;
      }
      return set;
    } catch (e) { return null; }
  }

  // Version 1: `1~name~weapon~head~…`, kept so links already shared still open.
  function decodeV1(str, data) {
    const parts = str.split("~");
    if (parts[0] !== "1" || parts.length < 9) return null;
    const b36 = s => { const n = parseInt(s, 36); return Number.isFinite(n) && n >= 0 ? n : null; };
    const list = s => (s ? s.split(".").map(b36).filter(n => n !== null) : []);
    let name = "Shared set";
    try { name = decodeURIComponent(parts[1] || "") || name; } catch (e) {}
    const set = { name, weapon: null, pieces: {}, talisman: null };
    for (const slot of SLOTS) set.pieces[slot] = null;
    const keep = ids => ids.filter(id => data.decos[id]);
    const wf = (parts[2] || "").split(",");
    if (wf[0]) {
      const id = b36(wf[1]);
      const index = window.SB_WEAPONS && window.SB_WEAPONS.index && window.SB_WEAPONS.index[wf[0]];
      if (index && id !== null && index.some(e => e[0] === id))
        set.weapon = { cls: wf[0], id, lv: b36(wf[2]) || 1, decos: keep(list(wf[3])) };
    }
    SLOTS.forEach((slot, i) => {
      const f = (parts[3 + i] || "").split(",");
      if (!f[0]) return;
      const id = b36(f[0]);
      if (id !== null && data.armor[slot][id]) set.pieces[slot] = { id, lv: b36(f[1]) || 0, decos: keep(list(f[2])) };
    });
    const tf = (parts[8] || "").split(",");
    if (tf[0]) {
      const rar = b36(tf[0]), slots = b36(tf[1]);
      const sk = (tf[2] ? tf[2].split(".") : []).map(pair => {
        const [t, p] = pair.split(":");
        const tree = b36(t), pts = parseInt(p, 10);
        return tree !== null && Number.isFinite(pts) && data.skills.trees[tree] ? [tree, pts] : null;
      }).filter(Boolean);
      if (rar !== null && rar >= 1 && rar <= 10 && slots !== null && slots <= 3)
        set.talisman = { rar, slots, sk, decos: keep(list(tf[3])) };
    }
    return set;
  }

  const decode = (str, data) =>
    (!str ? null : str.indexOf("~") >= 0 ? decodeV1(str, data) : decodeV2(str, data));

  const linkFor = set => location.origin + location.pathname + "#s=" + encode(set);
  const fromHash = (hash, data) => (/^#s=/.test(hash || "") ? decode(hash.slice(3), data) : null);

  return { encode, decode, linkFor, fromHash, VERSION };
})();
