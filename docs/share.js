// share.js — a whole set in a URL.
//
// There is no server behind this app, so a shared set has to travel inside the
// link itself. The set is packed into the hash as `#s=…`, which the browser
// never sends anywhere: the person you send it to gets the set, and nobody
// else sees it in a log.
//
// Format, version 1 — fields separated by `~`, lists by `.`:
//
//   1~<name>~<weapon>~<head>~<chest>~<arms>~<waist>~<legs>~<talisman>
//
//   weapon    cls,id,lv,deco.deco.deco     ("" when none)
//   armor     id,lv,deco.deco.deco         ("" when the slot is empty)
//   talisman  rar,slots,tree:pts.tree:pts,deco.deco   ("" when none)
//
// Ids are base36 to keep links short, and the name is URI-encoded last so it
// cannot break the separators. Every number is re-checked on the way back in:
// a hand-edited link can only produce a set the builder could have built, or
// nothing at all.
window.SBShare = (function () {
  "use strict";
  const VERSION = "1";
  const SLOTS = ["head", "chest", "arms", "waist", "legs"];
  const b36 = n => Number(n).toString(36);
  const num = s => {
    const n = parseInt(s, 36);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const packDecos = ids => (ids || []).map(b36).join(".");
  const unpackDecos = s => (s ? s.split(".").map(num).filter(n => n !== null) : []);

  function encode(set) {
    const w = set.weapon;
    const parts = [
      VERSION,
      encodeURIComponent(set.name || ""),
      w ? [w.cls, b36(w.id), b36(w.lv || 1), packDecos(w.decos)].join(",") : "",
    ];
    for (const slot of SLOTS) {
      const p = set.pieces[slot];
      parts.push(p ? [b36(p.id), b36(p.lv || 0), packDecos(p.decos)].join(",") : "");
    }
    const t = set.talisman;
    parts.push(t ? [
      b36(t.rar || 1), b36(t.slots || 0),
      (t.sk || []).map(([tree, pts]) => `${b36(tree)}:${pts}`).join("."),
      packDecos(t.decos),
    ].join(",") : "");
    return parts.join("~");
  }

  // Rebuild a set from a packed string, checking every id against the real
  // data. Anything that does not resolve is dropped rather than guessed at, so
  // a corrupted link degrades to a partial set instead of a broken page.
  function decode(str, data) {
    if (typeof str !== "string" || !str) return null;
    const parts = str.split("~");
    if (parts[0] !== VERSION || parts.length < 9) return null;

    let name = "Shared set";
    try { name = decodeURIComponent(parts[1] || "") || "Shared set"; } catch (e) {}
    const set = { name, weapon: null, pieces: {}, talisman: null };
    for (const slot of SLOTS) set.pieces[slot] = null;

    const validDecos = ids => ids.filter(id => data.decos[id]);

    const wf = (parts[2] || "").split(",");
    if (wf.length >= 3 && wf[0]) {
      const cls = wf[0], id = num(wf[1]), lv = num(wf[2]);
      const known = window.SB_WEAPONS && window.SB_WEAPONS.index && window.SB_WEAPONS.index[cls];
      if (known && id !== null && known.some(e => e[0] === id))
        set.weapon = { cls, id, lv: lv || 1, decos: validDecos(unpackDecos(wf[3])) };
    }
    SLOTS.forEach((slot, i) => {
      const f = (parts[3 + i] || "").split(",");
      if (!f[0]) return;
      const id = num(f[0]);
      if (id === null || !data.armor[slot][id]) return;
      set.pieces[slot] = { id, lv: num(f[1]) || 0, decos: validDecos(unpackDecos(f[2])) };
    });
    const tf = (parts[8] || "").split(",");
    if (tf[0]) {
      const rar = num(tf[0]), slots = num(tf[1]);
      const sk = (tf[2] ? tf[2].split(".") : []).map(pair => {
        const [t, p] = pair.split(":");
        const tree = num(t), pts = parseInt(p, 10);
        return tree !== null && Number.isFinite(pts) && data.skills.trees[tree] ? [tree, pts] : null;
      }).filter(Boolean);
      if (rar !== null && rar >= 1 && rar <= 10 && slots !== null && slots <= 3)
        set.talisman = { rar, slots, sk, decos: validDecos(unpackDecos(tf[3])) };
    }
    return set;
  }

  const linkFor = set => location.origin + location.pathname + "#s=" + encode(set);
  const fromHash = (hash, data) =>
    (/^#s=/.test(hash || "") ? decode(hash.slice(3), data) : null);

  return { encode, decode, linkFor, fromHash, VERSION };
})();
