/* UI — equipment cards and the results panel. All DOM writing lives here;
 * state changes go through the api callbacks that app.js provides. */
window.SBUI = (function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = window.SBPickers.esc;
  const iconPath = window.SBPickers.iconPath;
  const SLOTS = ["head", "chest", "arms", "waist", "legs"];
  const SLOT_LABEL = { head: "Head", chest: "Chest", arms: "Arms", waist: "Waist", legs: "Legs" };
  const SLOT_ICON = { head: "armor_head", chest: "armor_body", arms: "armor_arms", waist: "armor_waist", legs: "armor_legs" };
  const ELEMENTS = ["Fire", "Water", "Thunder", "Ice", "Dragon"];
  const SHARP_COLORS = ["#d1312d", "#d8623b", "#d9c440", "#7ac74f", "#4f9bd9", "#eeeef4", "#b78fe8"];
  const treeName = t => window.SB_SKILLS.trees[t] || `#${t}`;

  function toast(msg, ms = 2600) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
  }
  function confirmDialog(title, bodyHtml, onOk) {
    $("confirmTitle").textContent = title;
    $("confirmBody").innerHTML = bodyHtml;
    $("confirmModal").classList.remove("hidden");
    const done = () => {
      $("confirmModal").classList.add("hidden");
      $("confirmOk").onclick = $("confirmCancel").onclick = null;
    };
    $("confirmOk").onclick = () => { done(); onOk(); };
    $("confirmCancel").onclick = done;
  }

  // ── Shared fragments ───────────────────────────────────────────────────
  function decoRowHtml(target, decoIds, total) {
    const decos = window.SB_DECOS;
    let used = 0;
    const chips = (decoIds || []).map((id, i) => {
      const d = decos[id];
      if (!d) return "";
      used += d.slots;
      return `<span class="deco-slot" data-deco-i="${i}" title="Remove">
        ${esc(d.n)} <span class="cost">[${d.slots}]</span><span class="x">✕</span></span>`;
    }).join("");
    const free = total - used;
    const add = free > 0
      ? `<span class="deco-slot empty" data-deco-add="1">+ decoration</span>` : "";
    const label = `<span class="deco-free${used > total ? " over" : ""}">${used}/${total} slots</span>`;
    return total || (decoIds || []).length
      ? `<div class="deco-row" data-target='${JSON.stringify(target)}'>${label}${chips}${add}</div>` : "";
  }
  function wireDecoRow(card, api, freeOf) {
    for (const row of card.querySelectorAll(".deco-row")) {
      const target = JSON.parse(row.dataset.target);
      row.querySelectorAll("[data-deco-i]").forEach(chip =>
        chip.addEventListener("click", () => api.removeDeco(target, Number(chip.dataset.decoI))));
      const add = row.querySelector("[data-deco-add]");
      if (add) add.addEventListener("click", () =>
        window.SBPickers.openDecoPicker(target, freeOf(target), api));
    }
  }
  const skillChips = sk => sk.length
    ? `<div class="card-skills">${sk.map(([t, p]) => t === window.SBEngine.TORSO_UP
        ? `<span class="skill-chip torso">Torso Up</span>`
        : `<span class="skill-chip${p < 0 ? " neg" : ""}">${esc(treeName(t))} ${p > 0 ? "+" + p : p}</span>`).join("")}</div>`
    : "";

  // ── Cards ──────────────────────────────────────────────────────────────
  function renderWeaponCard(set, resolved, api) {
    const card = $("card-weapon");
    const w = set.weapon;
    if (!w || !resolved.weaponStat) {
      card.innerHTML = `<div class="card-head">
        <img class="card-icon" src="assets/icons/icon_great_sword.png" alt="">
        <span class="card-kind">Weapon</span>
        <span class="card-name empty">${w ? "loading…" : "No weapon — pick one"}</span>
        <span class="card-buttons"><button class="nav-btn" data-act="pick">Pick</button></span>
      </div>`;
      card.querySelector("[data-act=pick]").addEventListener("click", () => window.SBPickers.openWeaponPicker(api));
      return;
    }
    const cls = window.SB_WEAPONS.classes.find(c => c.key === w.cls);
    const st = resolved.weaponStat;
    const levels = resolved.weaponLevels;
    const lvOptions = levels.map(l => `<option value="${l.lv}"${l.lv === st.lv ? " selected" : ""}>LV ${l.lv}</option>`).join("");
    const eles = (st.ele || []).map(([n, v]) => `<span class="ws"><span class="k">${esc(n)}</span><b>${v}</b></span>`).join("");
    const sharp = st.sh ? `<div class="sharp-wrap"><span class="sharp-label">Sharpness</span><div>${
      st.sh.map((band, i) => `<div class="sharp-bar" title="${["Base", "+1", "+2"][i]}">${
        band.map((v, ci) => v ? `<span style="width:${v * 5}px;background:${SHARP_COLORS[ci]}"></span>` : "").join("")
      }</div>`).join("")}</div></div>` : "";
    const extras = [];
    if (st.x) {
      if (st.x.shell) extras.push(["Shell", st.x.shell]);
      if (st.x.phial) extras.push(["Phial", st.x.phial]);
      if (st.x.notes) extras.push(["Notes", st.x.notes.join(" ")]);
      if (st.x.arc) extras.push(["Arc", st.x.arc]);
      if (st.x.kinsect) extras.push(["Kinsect", st.x.kinsect.name]);
      if (st.x.stats) extras.push(["Reload", st.x.stats.reload], ["Recoil", st.x.stats.recoil], ["Deviation", st.x.stats.deviation]);
    }
    card.innerHTML = `<div class="card-head">
      <img class="card-icon" src="${iconPath(cls.icon, st.rar)}" alt="">
      <span class="card-kind">${esc(cls.label)}</span>
      <span class="card-name">${esc(st.n)}</span>
      <span class="card-buttons">
        <select class="mini-select lv-select" data-act="lv">${lvOptions}</select>
        <button class="nav-btn" data-act="pick">Change</button>
        <button class="nav-btn" data-act="clear">✕</button>
      </span>
    </div>
    <div class="weapon-stats">
      <span class="ws"><span class="k">Attack</span><b>${st.raw}</b></span>
      ${st.aff ? `<span class="ws"><span class="k">Affinity</span><b>${st.aff}%</b></span>` : ""}
      ${st.def ? `<span class="ws"><span class="k">Def</span><b>+${st.def}</b></span>` : ""}
      ${eles}
      <span class="ws"><span class="k">Slots</span><b>${window.SBPickers.slotPips(st.slots)}</b></span>
      ${extras.map(([k, v]) => `<span class="ws"><span class="k">${esc(k)}</span><b>${esc(String(v))}</b></span>`).join("")}
    </div>
    ${sharp}
    ${decoRowHtml({ kind: "weapon" }, w.decos, st.slots)}`;
    card.querySelector("[data-act=pick]").addEventListener("click", () => window.SBPickers.openWeaponPicker(api));
    card.querySelector("[data-act=clear]").addEventListener("click", () => api.clearWeapon());
    card.querySelector("[data-act=lv]").addEventListener("change", e => api.setWeaponLevel(Number(e.target.value)));
    wireDecoRow(card, api, api.freeSlots);
  }

  function renderArmorCard(slot, set, api) {
    const card = $(`card-${slot}`);
    const p = set.pieces[slot];
    const a = p && window.SB_ARMOR[slot][p.id];
    if (!a) {
      card.innerHTML = `<div class="card-head">
        <img class="card-icon" src="assets/icons/icon_${SLOT_ICON[slot]}.png" alt="">
        <span class="card-kind">${SLOT_LABEL[slot]}</span>
        <span class="card-name empty">No ${slot} piece — pick one</span>
        <span class="card-buttons"><button class="nav-btn" data-act="pick">Pick</button></span>
      </div>`;
      card.querySelector("[data-act=pick]").addEventListener("click", () => window.SBPickers.openArmorPicker(slot, api));
      return;
    }
    const maxLv = Math.min(a.maxLv || a.lv.length, a.lv.length);
    const lv = Math.min(p.lv || maxLv, maxLv);
    const lvOptions = Array.from({ length: maxLv }, (_, i) =>
      `<option value="${i + 1}"${i + 1 === lv ? " selected" : ""}>LV ${i + 1}</option>`).join("");
    card.innerHTML = `<div class="card-head">
      <img class="card-icon" src="${iconPath(SLOT_ICON[slot], a.rar)}" alt="">
      <span class="card-kind">${SLOT_LABEL[slot]}</span>
      <span class="card-name">${esc(a.n)}</span>
      ${a.gender !== 2 ? `<span class="gender-pill g${a.gender}">${a.gender ? "F" : "M"}</span>` : ""}
      <span class="card-sub">Def ${a.lv[lv - 1]}</span>
      <span class="card-buttons">
        <select class="mini-select lv-select" data-act="lv">${lvOptions}</select>
        <button class="nav-btn" data-act="pick">Change</button>
        <button class="nav-btn" data-act="clear">✕</button>
      </span>
    </div>
    ${skillChips(a.sk)}
    ${decoRowHtml({ kind: "piece", slot }, p.decos, a.slots)}`;
    card.querySelector("[data-act=pick]").addEventListener("click", () => window.SBPickers.openArmorPicker(slot, api));
    card.querySelector("[data-act=clear]").addEventListener("click", () => api.clearPiece(slot));
    card.querySelector("[data-act=lv]").addEventListener("change", e => api.setPieceLevel(slot, Number(e.target.value)));
    wireDecoRow(card, api, api.freeSlots);
  }

  function renderTalismanCard(set, api) {
    const card = $("card-talisman");
    const t = set.talisman;
    const charm = window.SB_CHARM;
    const talOptions = `<option value="">None</option>` + Object.entries(charm.names).map(([id, name]) =>
      `<option value="${id}"${t && t.rar === Number(id) ? " selected" : ""}>${esc(name)} (R${id})</option>`).join("");
    let form = "";
    if (t) {
      const table = charm.tiers[window.SBEngine.TAL_TIER[t.rar]] || {};
      const s1Trees = Object.keys(table).filter(tr => table[tr][0] !== 0 || table[tr][1] !== 0)
        .map(Number).sort((a, b) => treeName(a).localeCompare(treeName(b)));
      const s2Trees = Object.keys(table).filter(tr => table[tr][2] !== 0 || table[tr][3] !== 0)
        .map(Number).sort((a, b) => treeName(a).localeCompare(treeName(b)));
      const sk1 = t.sk[0] || [s1Trees[0], 1];
      const sk2 = t.sk[1] || null;
      const r1 = table[sk1[0]] || [0, 0, 0, 0];
      const r2 = sk2 ? (table[sk2[0]] || [0, 0, 0, 0]) : null;
      form = `<div class="tal-form">
        <div class="tal-field"><label>Skill 1</label>
          <select data-act="sk1">${s1Trees.map(tr =>
            `<option value="${tr}"${tr === sk1[0] ? " selected" : ""}>${esc(treeName(tr))}</option>`).join("")}</select></div>
        <div class="tal-field"><label>Points (${r1[0]} to ${r1[1]})</label>
          <input type="number" data-act="pts1" value="${sk1[1]}" min="${r1[0]}" max="${r1[1]}"></div>
        <div class="tal-field"><label>Skill 2</label>
          <select data-act="sk2"><option value="">None</option>${s2Trees.map(tr =>
            `<option value="${tr}"${sk2 && tr === sk2[0] ? " selected" : ""}>${esc(treeName(tr))}</option>`).join("")}</select></div>
        ${sk2 ? `<div class="tal-field"><label>Points (${r2[2]} to ${r2[3]})</label>
          <input type="number" data-act="pts2" value="${sk2[1]}" min="${r2[2]}" max="${r2[3]}"></div>` : ""}
        <div class="tal-field"><label>Slots</label>
          <select data-act="slots">${[0, 1, 2, 3].map(n =>
            `<option value="${n}"${t.slots === n ? " selected" : ""}>${n}</option>`).join("")}</select></div>
      </div>`;
      const problems = window.SBEngine.validateTalisman(t, charm, window.SB_SKILLS);
      if (problems.length) form += `<div class="tal-problems">${problems.map(p => `<div>${esc(p)}</div>`).join("")}</div>`;
      form += decoRowHtml({ kind: "talisman" }, t.decos, t.slots);
    }
    const summary = t ? `${charm.names[t.rar]}` : "No talisman";
    card.innerHTML = `<div class="card-head">
      <img class="card-icon" src="assets/icons/icon_talisman${t ? "_r" + t.rar : ""}.png" alt="">
      <span class="card-kind">Talisman</span>
      <span class="card-name${t ? "" : " empty"}">${esc(summary)}</span>
      <span class="card-buttons">
        <select class="mini-select" data-act="tier">${talOptions}</select>
      </span>
    </div>${form}`;
    card.querySelector("[data-act=tier]").addEventListener("change", e =>
      api.setTalismanRarity(e.target.value ? Number(e.target.value) : null));
    if (t) {
      card.querySelector("[data-act=sk1]").addEventListener("change", e => api.setTalismanSkill(0, Number(e.target.value)));
      card.querySelector("[data-act=pts1]").addEventListener("change", e => api.setTalismanPoints(0, Number(e.target.value)));
      card.querySelector("[data-act=sk2]").addEventListener("change", e =>
        api.setTalismanSkill(1, e.target.value ? Number(e.target.value) : null));
      const p2 = card.querySelector("[data-act=pts2]");
      if (p2) p2.addEventListener("change", e => api.setTalismanPoints(1, Number(e.target.value)));
      card.querySelector("[data-act=slots]").addEventListener("change", e => api.setTalismanSlots(Number(e.target.value)));
      wireDecoRow(card, api, api.freeSlots);
    }
  }

  // ── Results ────────────────────────────────────────────────────────────
  function nextThresholdHint(tree, pts) {
    const ladder = window.SB_SKILLS.active[tree];
    if (!ladder || pts <= 0) return "";
    const next = ladder.find(s => s[0] > pts);
    return next ? `${next[0] - pts} to ${next[1]}` : "";
  }
  function renderResults(result) {
    const panel = $("resultsPanel");
    if (!result) { panel.innerHTML = `<div class="results-empty">Pick equipment to see totals.</div>`; return; }
    const r = result;
    const slotTotals = Object.values(r.slots).reduce((a, s) => [a[0] + s.used, a[1] + s.total], [0, 0]);
    const soulsByParent = {};
    for (const s of r.soulGrants) (soulsByParent[s.fromSoul] ||= []).push(s);
    const skillRow = (a, cls) => `<div class="active-skill${a.negative ? " neg" : ""}${cls || ""}">
        <span class="an">${esc(a.name)}</span>
        ${a.soul ? `<span class="soul-tag">soul</span>` : ""}
        <span class="ad" title="${esc(a.desc || "")}">${esc(a.desc || "")}</span>
        <span class="apts">${a.threshold > 0 ? "+" + a.threshold : a.threshold}</span>
      </div>`;
    const activeHtml = r.active.map(a =>
      skillRow(a) + (soulsByParent[a.tree] || []).map(s => skillRow(s, " soul-grant")).join("")
    ).join("");
    const treeRows = Object.entries(r.treePoints)
      .map(([t, p]) => [Number(t), p])
      .filter(([t, p]) => p !== 0 && t !== window.SBEngine.TORSO_UP)
      .sort((a, b) => b[1] - a[1])
      .map(([t, p]) => {
        const hit = r.active.find(a => a.tree === t);
        return `<div class="tree-row${hit ? " hit" : ""}${hit && hit.negative ? " neg-hit" : ""}">
          <span class="tn">${esc(treeName(t))}</span>
          <span class="tp${p < 0 ? " neg" : ""}">${p > 0 ? "+" + p : p}</span>
          <span class="tnext">${hit ? esc(hit.name) : esc(nextThresholdHint(t, p))}</span>
        </div>`;
      }).join("");
    panel.innerHTML = `
      <div class="res-title">Totals${r.torsoUpCount ? `<span class="torso-badge">Torso Up ×${r.torsoUpCount + 1}</span>` : ""}</div>
      <div class="totals-row">
        <span class="t"><span class="k">Defense</span><b>${r.defense}</b><span class="max">/ ${r.defenseMax} max</span></span>
        <span class="t"><span class="k">Slots</span><b class="slot-summary">${slotTotals[0]}/${slotTotals[1]}</b></span>
      </div>
      <div class="res-grid">${r.res.map((v, i) => `
        <div class="res-el"><span class="el el-${ELEMENTS[i].toLowerCase()}">${ELEMENTS[i]}</span>
        <b class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v}</b></div>`).join("")}
      </div>
      ${r.problems.length ? `<ul class="problem-list">${r.problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      <div class="res-title">Activated skills</div>
      ${activeHtml || `<div class="results-empty">Nothing activates yet.</div>`}
      <div class="res-title">Skill points</div>
      ${treeRows || `<div class="results-empty">No skill points yet.</div>`}`;
  }

  function renderCards(set, resolved, api) {
    renderWeaponCard(set, resolved, api);
    for (const slot of SLOTS) renderArmorCard(slot, set, api);
    renderTalismanCard(set, api);
  }

  return { renderCards, renderResults, toast, confirmDialog, SLOTS };
})();
