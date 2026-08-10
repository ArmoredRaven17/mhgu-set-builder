/* Pickers — the modal flows that choose armor, weapons and decorations.
 * Rendering only; every choice lands through api.update(). */
window.SBPickers = (function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const SLOT_ICON = { head: "armor_head", chest: "armor_body", arms: "armor_arms", waist: "armor_waist", legs: "armor_legs" };
  const iconSuffix = r => (r >= 11 ? "_rX" : r >= 1 ? "_r" + r : "");
  const iconPath = (slug, r) => `assets/icons/icon_${slug}${iconSuffix(r)}.png`;
  const slotPips = n => "◯".repeat(n) + "―".repeat(3 - n);
  const treeName = t => window.SB_SKILLS.trees[t] || `#${t}`;
  const MAX_ROWS = 250;

  function openModal(title) {
    $("pickerTitle").textContent = title;
    $("pickerFilters").innerHTML = "";
    $("pickerList").innerHTML = "";
    $("pickerModal").classList.remove("hidden");
  }
  function closeModal() {
    $("pickerModal").classList.add("hidden");
  }

  // Rows shared by every list picker: filter, cap, render, click.
  function renderRows(items, renderRow, onPick) {
    const list = $("pickerList");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const it of items.slice(0, MAX_ROWS)) {
      const row = document.createElement("div");
      row.className = "picker-row";
      row.innerHTML = renderRow(it);
      row.addEventListener("click", () => { onPick(it); closeModal(); });
      frag.appendChild(row);
    }
    list.appendChild(frag);
    if (items.length > MAX_ROWS) {
      const note = document.createElement("div");
      note.className = "picker-note";
      note.textContent = `${items.length - MAX_ROWS} more — type to narrow the list.`;
      list.appendChild(note);
    } else if (!items.length) {
      const note = document.createElement("div");
      note.className = "picker-note";
      note.textContent = "Nothing matches.";
      list.appendChild(note);
    }
  }

  // ── Armor ──────────────────────────────────────────────────────────────
  function openArmorPicker(slot, api) {
    openModal(`Pick a ${slot} piece`);
    const armor = window.SB_ARMOR[slot];
    const all = Object.entries(armor).map(([id, a]) => ({ id: Number(id), a }));
    all.sort((x, y) => (x.a.ord || 0) - (y.a.ord || 0));

    const filters = { text: "", gender: "all", cls: "all" };
    const bar = $("pickerFilters");
    bar.innerHTML = `
      <input type="text" id="pkSearch" placeholder="Search name, set or skill…">
      <select id="pkGender" class="mini-select">
        <option value="all">Any gender</option><option value="0">Male</option><option value="1">Female</option>
      </select>
      <select id="pkClass" class="mini-select">
        <option value="all">Any class</option><option value="B">Blademaster</option><option value="G">Gunner</option>
      </select>`;
    const apply = () => {
      const t = filters.text.toLowerCase();
      const items = all.filter(({ a }) => {
        if (filters.gender !== "all" && a.gender !== 2 && a.gender !== Number(filters.gender)) return false;
        if (filters.cls !== "all" && a.cls !== "A" && a.cls !== filters.cls) return false;
        if (!t) return true;
        if (a.n.toLowerCase().includes(t)) return true;
        if (a.set && String(a.set).toLowerCase().includes(t)) return true;
        return a.sk.some(([tr]) => treeName(tr).toLowerCase().includes(t));
      });
      renderRows(items, ({ a }) => `
        <img class="pr-icon" src="${iconPath(SLOT_ICON[slot], a.rar)}" alt="">
        <div class="pr-main">
          <div class="pr-name">${esc(a.n)}${a.gender !== 2 ? ` <span class="gender-pill g${a.gender}">${a.gender ? "F" : "M"}</span>` : ""}</div>
          <div class="pr-sub">${a.sk.filter(([tr]) => tr !== 203).map(([tr, p]) => `${esc(treeName(tr))} ${p > 0 ? "+" + p : p}`).join(", ")
            }${a.sk.some(([tr]) => tr === 203) ? (a.sk.length > 1 ? ", " : "") + "Torso Up" : ""}</div>
        </div>
        <div class="pr-right">
          <span class="pr-slots">${slotPips(a.slots)}</span>
          <span class="rarity-badge rarity-${a.rar}">R${a.rar >= 11 ? "X" : a.rar}</span>
        </div>`,
        ({ id }) => api.setPiece(slot, id));
    };
    $("pkSearch").addEventListener("input", e => { filters.text = e.target.value; apply(); });
    $("pkGender").addEventListener("change", e => { filters.gender = e.target.value; apply(); });
    $("pkClass").addEventListener("change", e => { filters.cls = e.target.value; apply(); });
    apply();
    $("pkSearch").focus();
  }

  // ── Weapon: class grid, then tree list ─────────────────────────────────
  function openWeaponPicker(api) {
    openModal("Pick a weapon type");
    const list = $("pickerList");
    const grid = document.createElement("div");
    grid.className = "class-grid";
    for (const c of window.SB_WEAPONS.classes) {
      const cell = document.createElement("div");
      cell.className = "class-cell";
      cell.innerHTML = `<img src="assets/icons/icon_${c.icon}.png" alt=""><span>${esc(c.label)}</span>`;
      cell.addEventListener("click", () => openWeaponTreeList(c, api));
      grid.appendChild(cell);
    }
    list.appendChild(grid);
  }
  function openWeaponTreeList(cls, api) {
    openModal(`Pick a ${cls.label}`);
    // index entry: [id, name, rarity, finalName, maxLevel, elementMask]
    const all = window.SB_WEAPONS.index[cls.key].map(e => ({ id: e[0], n: e[1], rar: e[2], fin: e[3], maxLv: e[4] }));
    const bar = $("pickerFilters");
    bar.innerHTML = `<input type="text" id="pkSearch" placeholder="Search weapon or final name…">`;
    const apply = () => {
      const t = $("pkSearch").value.toLowerCase();
      const items = !t ? all : all.filter(w =>
        w.n.toLowerCase().includes(t) || (w.fin && String(w.fin).toLowerCase().includes(t)));
      renderRows(items, w => `
        <img class="pr-icon" src="${iconPath(cls.icon, w.rar)}" alt="">
        <div class="pr-main">
          <div class="pr-name">${esc(w.n)}</div>
          <div class="pr-sub">${w.fin && w.fin !== w.n ? `→ ${esc(String(w.fin))} · ` : ""}${w.maxLv} level${w.maxLv > 1 ? "s" : ""}</div>
        </div>
        <div class="pr-right"><span class="rarity-badge rarity-${w.rar}">R${w.rar >= 11 ? "X" : w.rar}</span></div>`,
        w => api.setWeapon(cls.key, w.id));
    };
    $("pkSearch").addEventListener("input", apply);
    apply();
    $("pkSearch").focus();
  }

  // ── Decorations ────────────────────────────────────────────────────────
  // target: {kind:"piece", slot} | {kind:"weapon"} | {kind:"talisman"}
  function openDecoPicker(target, freeSlots, api) {
    openModal(`Add a decoration (${freeSlots} slot${freeSlots === 1 ? "" : "s"} free)`);
    const decos = window.SB_DECOS;
    const all = Object.entries(decos)
      .map(([id, d]) => ({ id: Number(id), d }))
      .filter(({ d }) => d.slots <= freeSlots)
      .sort((x, y) => x.d.n.localeCompare(y.d.n));
    const bar = $("pickerFilters");
    bar.innerHTML = `<input type="text" id="pkSearch" placeholder="Search decoration or skill…">`;
    const apply = () => {
      const t = $("pkSearch").value.toLowerCase();
      const items = !t ? all : all.filter(({ d }) =>
        d.n.toLowerCase().includes(t) || d.sk.some(([tr]) => treeName(tr).toLowerCase().includes(t)));
      renderRows(items, ({ d }) => `
        <span class="pr-icon deco-pip rarity-badge rarity-${d.rar}">${d.slots}</span>
        <div class="pr-main">
          <div class="pr-name">${esc(d.n)}</div>
          <div class="pr-sub">${d.sk.map(([tr, p]) => `${esc(treeName(tr))} ${p > 0 ? "+" + p : p}`).join(", ")}</div>
        </div>
        <div class="pr-right"><span class="pr-slots">${slotPips(d.slots)}</span></div>`,
        ({ id }) => api.addDeco(target, id));
    };
    $("pkSearch").addEventListener("input", apply);
    apply();
    $("pkSearch").focus();
  }

  function init() {
    $("pickerCancel").addEventListener("click", closeModal);
    $("pickerModal").addEventListener("mousedown", e => { if (e.target === $("pickerModal")) closeModal(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !$("pickerModal").classList.contains("hidden")) closeModal();
    });
  }

  return { init, openArmorPicker, openWeaponPicker, openDecoPicker, iconPath, slotPips, esc };
})();
