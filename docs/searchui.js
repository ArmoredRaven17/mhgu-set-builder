/* searchui.js — the Find Sets modal. Collects targets and options, runs
 * SBSearch, lists results, applies one as a new set via the app api. */
window.SBSearchUI = (function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = window.SBPickers.esc;
  const treeName = t => window.SB_SKILLS.trees[t] || `#${t}`;
  const MAX_TARGETS = 5;

  let api = null;
  let targets = [];          // [{tree, pts, name}]
  let lastResults = [];

  // Every positive activated skill, for the typeahead.
  const OPTIONS = [];
  for (const [treeStr, ladder] of Object.entries(window.SB_SKILLS.active)) {
    for (const [pts, name] of ladder) {
      if (pts > 0) OPTIONS.push({ tree: Number(treeStr), pts, name });
    }
  }
  OPTIONS.sort((a, b) => a.name.localeCompare(b.name));

  function renderTargets() {
    const wrap = $("searchTargets");
    wrap.innerHTML = targets.map((t, i) =>
      `<span class="skill-chip target-chip" data-i="${i}" title="Remove">
        ${esc(t.name)} <span class="tc-sub">(${esc(treeName(t.tree))} ${t.pts})</span> ✕</span>`).join("")
      + (targets.length < MAX_TARGETS
        ? `<span class="name-search search-add"><input type="text" id="searchAdd" placeholder="Add a skill…" autocomplete="off"><ul id="searchAddList" class="name-search-list hidden"></ul></span>`
        : "");
    wrap.querySelectorAll(".target-chip").forEach(chip =>
      chip.addEventListener("click", () => { targets.splice(Number(chip.dataset.i), 1); renderTargets(); }));
    const inp = $("searchAdd");
    if (!inp) return;
    const list = $("searchAddList");
    const refresh = () => {
      const q = inp.value.trim().toLowerCase();
      if (!q) { list.classList.add("hidden"); return; }
      const hits = OPTIONS.filter(o =>
        !targets.some(t => t.tree === o.tree) &&
        (o.name.toLowerCase().includes(q) || treeName(o.tree).toLowerCase().includes(q))).slice(0, 12);
      list.innerHTML = hits.map((o, i) =>
        `<li data-i="${i}">${esc(o.name)} <span class="tc-sub">(${esc(treeName(o.tree))} ${o.pts})</span></li>`).join("")
        || `<li class="ns-overflow">No match.</li>`;
      list.classList.remove("hidden");
      list.querySelectorAll("li[data-i]").forEach(li =>
        li.addEventListener("mousedown", () => { targets.push(hits[Number(li.dataset.i)]); renderTargets(); }));
    };
    inp.addEventListener("input", refresh);
    inp.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
    inp.focus();
  }

  function currentOptions() {
    const auto = api.weaponArmorClass();
    const clsSel = $("searchClass").value;
    const slotSel = $("searchWSlots").value;
    return {
      gender: Number($("searchGender").value),
      cls: clsSel === "auto" ? (auto || "B") : clsSel,
      maxRar: Number($("searchRar").value),
      weaponSlots: slotSel === "auto" ? api.currentWeaponSlots() : Number(slotSel),
      talisman: $("searchTal").value === "current" ? api.currentTalisman() : null,
    };
  }
  function syncOptionLabels() {
    const auto = api.weaponArmorClass();
    $("searchClass").options[0].text = `Auto (${auto === "G" ? "Gunner" : auto === "B" ? "Blademaster" : "no weapon → Blademaster"})`;
    $("searchWSlots").options[0].text = `Auto (${api.currentWeaponSlots()})`;
    const tal = api.currentTalisman();
    const talOpt = $("searchTal").options[1];
    talOpt.disabled = !tal;
    talOpt.text = tal ? `Current (${window.SB_CHARM.names[tal.rar] || "talisman"})` : "Current (none entered)";
    if (!tal) $("searchTal").value = "none";
  }

  function run() {
    if (!targets.length) { $("searchStatus").textContent = "Add at least one skill."; return; }
    $("searchStatus").textContent = "Searching…";
    $("searchResults").innerHTML = "";
    $("searchRun").disabled = true;
    setTimeout(() => {
      const t0 = performance.now();
      const query = { targets: targets.map(t => [t.tree, t.pts]), maxResults: 50, ...currentOptions() };
      let res;
      try { res = window.SBSearch.search(query, {
        skills: window.SB_SKILLS, souls: window.SB_SOULS,
        decos: window.SB_DECOS, armor: window.SB_ARMOR,
      }); } catch (e) { $("searchStatus").textContent = "Search failed."; $("searchRun").disabled = false; throw e; }
      const ms = Math.round(performance.now() - t0);
      lastResults = res.results;
      $("searchStatus").textContent = res.results.length
        ? `${res.results.length}${res.complete ? "" : "+"} set(s) in ${ms} ms.`
        : `Nothing reaches those skills with these options (${ms} ms).`;
      renderResults();
      $("searchRun").disabled = false;
    }, 30);
  }

  function renderResults() {
    const wrap = $("searchResults");
    wrap.innerHTML = lastResults.map((r, i) => {
      const names = ["head", "chest", "arms", "waist", "legs"].map(slot =>
        window.SB_ARMOR[slot][r.set.pieces[slot].id].n);
      const decoCount = Object.values(r.set.pieces).reduce((n, p) => n + p.decos.length, 0)
        + (r.set.weapon ? r.set.weapon.decos.length : 0)
        + (r.set.talisman ? r.set.talisman.decos.length : 0);
      return `<div class="picker-row search-result" data-i="${i}">
        <div class="pr-main">
          <div class="pr-name">${names.map(esc).join(" · ")}</div>
          <div class="pr-sub">${r.engine.active.filter(a => !a.negative).map(a => esc(a.name)).join(", ")}</div>
        </div>
        <div class="pr-right">
          <span class="sr-stat">Def ${r.defense}</span>
          <span class="sr-stat">${decoCount} deco</span>
          <span class="sr-stat">${r.spare} free</span>
          <button class="nav-btn" data-apply="${i}">Apply</button>
        </div>
      </div>`;
    }).join("");
    wrap.querySelectorAll("[data-apply]").forEach(btn =>
      btn.addEventListener("click", () => {
        api.applyFoundSet(lastResults[Number(btn.dataset.apply)].set);
        close();
      }));
  }

  function open() {
    syncOptionLabels();
    renderTargets();
    $("searchModal").classList.remove("hidden");
  }
  function close() { $("searchModal").classList.add("hidden"); }

  function init(appApi) {
    api = appApi;
    $("findSetsBtn").addEventListener("click", open);
    $("searchClose").addEventListener("click", close);
    $("searchRun").addEventListener("click", run);
    $("searchModal").addEventListener("mousedown", e => { if (e.target === $("searchModal")) close(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !$("searchModal").classList.contains("hidden")) close();
    });
  }

  return { init };
})();
