/* searchui.js — the Find Sets modal and the My Talismans store.
 *
 * The search itself runs in a Web Worker (search-worker.js) so a long query
 * never freezes the page; Cancel terminates that worker, since a synchronous
 * search can't answer messages while it runs. If workers aren't available the
 * same search runs inline as a fallback.
 */
window.SBSearchUI = (function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = window.SBPickers.esc;
  const treeName = t => window.SB_SKILLS.trees[t] || `#${t}`;
  const MAX_TARGETS = 5;

  let api = null;
  let targets = [];          // [{tree, pts, name}]
  let lastResults = [];
  let worker = null, workerReady = false, running = false;

  // Every positive activated skill, for the typeahead.
  const OPTIONS = [];
  for (const [treeStr, ladder] of Object.entries(window.SB_SKILLS.active))
    for (const [pts, name] of ladder) if (pts > 0) OPTIONS.push({ tree: Number(treeStr), pts, name });
  OPTIONS.sort((a, b) => a.name.localeCompare(b.name));

  const talLabel = t => {
    const skills = t.sk.map(([tr, p]) => `${treeName(tr)} ${p > 0 ? "+" + p : p}`).join(", ");
    return `${window.SB_CHARM.names[t.rar] || "Talisman"} — ${skills}, ${t.slots} slot${t.slots === 1 ? "" : "s"}`;
  };

  // ── Targets: a stationary add box, chips collect below it ──────────────
  function renderTargets() {
    const wrap = $("searchTargets");
    wrap.innerHTML = targets.map((t, i) =>
      `<span class="skill-chip target-chip" data-i="${i}" title="Remove">
        ${esc(t.name)} <span class="tc-sub">(${esc(treeName(t.tree))} ${t.pts})</span> ✕</span>`).join("");
    wrap.querySelectorAll(".target-chip").forEach(chip =>
      chip.addEventListener("click", () => { targets.splice(Number(chip.dataset.i), 1); renderTargets(); }));
    const full = targets.length >= MAX_TARGETS;
    $("searchAdd").disabled = full;
    $("searchAddHint").textContent = full ? `${MAX_TARGETS} skills max — remove one to swap.` : "";
    if (full) $("searchAddList").classList.add("hidden");
  }
  function wireAddBox() {
    const inp = $("searchAdd"), list = $("searchAddList");
    const refresh = () => {
      const q = inp.value.trim().toLowerCase();
      if (!q || targets.length >= MAX_TARGETS) { list.classList.add("hidden"); return; }
      const hits = OPTIONS.filter(o =>
        !targets.some(t => t.tree === o.tree) &&
        (o.name.toLowerCase().includes(q) || treeName(o.tree).toLowerCase().includes(q))).slice(0, 12);
      list.innerHTML = hits.map((o, i) =>
        `<li data-i="${i}">${esc(o.name)} <span class="tc-sub">(${esc(treeName(o.tree))} ${o.pts})</span></li>`).join("")
        || `<li class="ns-overflow">No match.</li>`;
      list.classList.remove("hidden");
      list.querySelectorAll("li[data-i]").forEach(li =>
        li.addEventListener("mousedown", () => {
          targets.push(hits[Number(li.dataset.i)]);
          inp.value = "";
          list.classList.add("hidden");
          renderTargets();
          if (targets.length < MAX_TARGETS) inp.focus();   // stay put, keep typing
        }));
    };
    inp.addEventListener("input", refresh);
    inp.addEventListener("focus", refresh);
    inp.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
  }

  // ── Options ────────────────────────────────────────────────────────────
  function fillRaritySelects() {
    const opts = Object.entries(window.SB_CHARM.names)
      .map(([id, n]) => `<option value="${id}">${esc(n)} (R${id})</option>`).join("");
    $("searchTalRar").innerHTML = opts;
    $("searchTalRar").value = "10";
    $("talAddRar").innerHTML = opts;
    $("talAddRar").value = "10";
  }
  function syncOptionLabels() {
    const auto = api.weaponArmorClass();
    $("searchClass").options[0].text = `Auto (${auto === "G" ? "Gunner" : auto === "B" ? "Blademaster" : "no weapon → Blademaster"})`;
    $("searchWSlots").options[0].text = `Auto (${api.currentWeaponSlots()})`;
    const mine = $("searchTalMode").value === "mine";
    $("searchTalRarWrap").classList.toggle("hidden", mine);
    $("searchTalMineWrap").classList.toggle("hidden", !mine);
    $("manageTalBtn").textContent = `Manage my talismans… (${api.getTalismans().length})`;
  }
  function currentOptions() {
    const auto = api.weaponArmorClass();
    const clsSel = $("searchClass").value;
    const slotSel = $("searchWSlots").value;
    const mode = $("searchTalMode").value;
    const trees = targets.map(t => t.tree);
    const talismans = mode === "mine"
      ? api.getTalismans()
      : window.SBSearch.generateTalismans(trees, window.SB_CHARM,
          { maxRar: Number($("searchTalRar").value), twoSkill: mode === "two" });
    return {
      gender: Number($("searchGender").value),
      cls: clsSel === "auto" ? (auto || "B") : clsSel,
      maxRar: Number($("searchRar").value),
      weaponSlots: slotSel === "auto" ? api.currentWeaponSlots() : Number(slotSel),
      talismans,
    };
  }

  // ── Worker plumbing ────────────────────────────────────────────────────
  // The scripts the worker needs, read off this page so their cache-busting
  // versions can never drift from index.html.
  function workerScripts() {
    return [...document.querySelectorAll("script[src]")]
      .map(s => s.getAttribute("src"))
      .filter(src => /^data\/(skills|souls|decos|armor)\.js/.test(src) || /^(engine|search)\.js/.test(src))
      .map(src => new URL(src, location.href).href);
  }
  function startWorker() {
    if (worker || typeof Worker === "undefined") return;
    try {
      worker = new Worker("search-worker.js?v=1");
      workerReady = false;
      worker.onmessage = e => {
        const m = e.data || {};
        if (m.type === "ready") { workerReady = true; return; }
        if (m.type === "progress") {
          if (running) $("searchStatus").textContent =
            `Searching… ${m.found} found, ${m.explored.toLocaleString()} sets checked.`;
          return;
        }
        if (m.type === "done") { finishSearch(m.res); return; }
        if (m.type === "error") { finishSearch(null, m.message); return; }
      };
      worker.onerror = () => { killWorker(); finishSearch(null, "worker failed"); };
      worker.postMessage({ type: "init", scripts: workerScripts() });
    } catch (e) { worker = null; }
  }
  function killWorker() {
    if (worker) { worker.terminate(); worker = null; workerReady = false; }
  }

  let searchStart = 0;
  function run() {
    if (running) return;
    if (!targets.length) { $("searchStatus").textContent = "Add at least one skill."; return; }
    const opts = currentOptions();
    if ($("searchTalMode").value === "mine" && !opts.talismans.length)
      $("searchAddHint").textContent = "";
    const query = { targets: targets.map(t => [t.tree, t.pts]), maxResults: 50, ...opts };
    running = true;
    searchStart = performance.now();
    $("searchRun").disabled = true;
    $("searchCancel").classList.remove("hidden");
    $("searchResults").innerHTML = "";
    $("searchStatus").textContent = "Searching…";
    startWorker();
    if (worker) {
      worker.postMessage({ type: "search", query });
    } else {
      // No worker available: run inline, after a paint so the status shows.
      setTimeout(() => {
        try { finishSearch(window.SBSearch.search(query, dataBundle())); }
        catch (e) { finishSearch(null, String(e && e.message || e)); }
      }, 30);
    }
  }
  const dataBundle = () => ({
    skills: window.SB_SKILLS, souls: window.SB_SOULS,
    decos: window.SB_DECOS, armor: window.SB_ARMOR,
  });
  function cancel() {
    if (!running) return;
    killWorker();
    running = false;
    $("searchRun").disabled = false;
    $("searchCancel").classList.add("hidden");
    $("searchStatus").textContent = "Cancelled.";
  }
  function finishSearch(res, err) {
    running = false;
    $("searchRun").disabled = false;
    $("searchCancel").classList.add("hidden");
    const ms = Math.round(performance.now() - searchStart);
    if (err || !res) { $("searchStatus").textContent = `Search failed: ${err || "no result"}.`; return; }
    lastResults = res.results;
    const talMode = $("searchTalMode").value;
    const hint = talMode === "mine" && !api.getTalismans().length
      ? " No talismans stored yet — only talisman-free sets were considered."
      : "";
    $("searchStatus").textContent = res.results.length
      ? `${res.results.length}${res.complete ? "" : "+"} set(s) in ${ms} ms.${hint}`
      : `Nothing reaches those skills with these options (${ms} ms).${hint}`;
    renderResults();
  }

  function renderResults() {
    const wrap = $("searchResults");
    wrap.innerHTML = lastResults.map((r, i) => {
      const names = ["head", "chest", "arms", "waist", "legs"].map(slot =>
        window.SB_ARMOR[slot][r.set.pieces[slot].id].n);
      const decoCount = Object.values(r.set.pieces).reduce((n, p) => n + p.decos.length, 0)
        + (r.set.weapon ? r.set.weapon.decos.length : 0)
        + (r.set.talisman ? r.set.talisman.decos.length : 0);
      const neg = r.engine.active.filter(a => a.negative);
      return `<div class="picker-row search-result" data-i="${i}">
        <div class="pr-main">
          <div class="pr-name">${names.map(esc).join(" · ")}</div>
          <div class="pr-sub">${r.engine.active.filter(a => !a.negative).map(a => esc(a.name)).join(", ")}${
            neg.length ? ` <span class="sr-neg">${neg.map(a => esc(a.name)).join(", ")}</span>` : ""}</div>
          <div class="pr-sub sr-tal">${r.set.talisman ? esc(talLabel(r.set.talisman)) : "No talisman needed"}</div>
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

  // ── My Talismans ───────────────────────────────────────────────────────
  function talTierTable(rar) {
    return window.SB_CHARM.tiers[window.SBEngine.TAL_TIER[rar]] || {};
  }
  function syncTalAddForm() {
    const rar = Number($("talAddRar").value);
    const table = talTierTable(rar);
    const opt = (t) => `<option value="${t}">${esc(treeName(t))}</option>`;
    const firsts = Object.keys(table).map(Number)
      .filter(t => table[t][0] !== 0 || table[t][1] !== 0)
      .sort((a, b) => treeName(a).localeCompare(treeName(b)));
    const seconds = Object.keys(table).map(Number)
      .filter(t => table[t][2] !== 0 || table[t][3] !== 0)
      .sort((a, b) => treeName(a).localeCompare(treeName(b)));
    const keep1 = $("talAddSk1").value, keep2 = $("talAddSk2").value;
    $("talAddSk1").innerHTML = firsts.map(opt).join("");
    $("talAddSk2").innerHTML = `<option value="">None</option>` + seconds.map(opt).join("");
    if (firsts.includes(Number(keep1))) $("talAddSk1").value = keep1;
    if (keep2 && seconds.includes(Number(keep2))) $("talAddSk2").value = keep2;
    const r1 = table[Number($("talAddSk1").value)] || [0, 0, 0, 0];
    const p1 = $("talAddPts1");
    p1.min = r1[0]; p1.max = r1[1];
    if (!p1.value || Number(p1.value) < r1[0] || Number(p1.value) > r1[1]) p1.value = r1[1];
    p1.title = `${r1[0]} to ${r1[1]}`;
    const s2 = $("talAddSk2").value;
    const p2 = $("talAddPts2");
    p2.disabled = !s2;
    if (s2) {
      const r2 = table[Number(s2)] || [0, 0, 0, 0];
      p2.min = r2[2]; p2.max = r2[3];
      if (!p2.value || Number(p2.value) < r2[2] || Number(p2.value) > r2[3]) p2.value = r2[3];
      p2.title = `${r2[2]} to ${r2[3]}`;
    } else { p2.value = ""; p2.title = ""; }
    $("talAddProblems").textContent = "";
  }
  function readTalForm() {
    const sk = [[Number($("talAddSk1").value), Number($("talAddPts1").value)]];
    if ($("talAddSk2").value) sk.push([Number($("talAddSk2").value), Number($("talAddPts2").value)]);
    return { rar: Number($("talAddRar").value), slots: Number($("talAddSlots").value), sk };
  }
  function renderTalList() {
    const list = api.getTalismans();
    $("talList").innerHTML = list.length
      ? list.map((t, i) => `<div class="picker-row">
          <div class="pr-main"><div class="pr-name">${esc(talLabel(t))}</div></div>
          <div class="pr-right"><button class="nav-btn" data-del="${i}">Remove</button></div>
        </div>`).join("")
      : `<div class="picker-note">No talismans stored yet.</div>`;
    $("talList").querySelectorAll("[data-del]").forEach(btn =>
      btn.addEventListener("click", () => { api.removeTalisman(Number(btn.dataset.del)); renderTalList(); syncOptionLabels(); }));
  }
  function addTalisman(t) {
    const problems = window.SBEngine.validateTalisman(t, window.SB_CHARM, window.SB_SKILLS);
    if (problems.length) { $("talAddProblems").innerHTML = problems.map(p => `<div>${esc(p)}</div>`).join(""); return false; }
    api.addTalisman(t);
    $("talAddProblems").textContent = "";
    renderTalList();
    syncOptionLabels();
    return true;
  }
  function openTalManager() {
    fillRaritySelects();
    syncTalAddForm();
    renderTalList();
    $("talModal").classList.remove("hidden");
  }

  function open() {
    syncOptionLabels();
    renderTargets();
    $("searchModal").classList.remove("hidden");
    if (targets.length < MAX_TARGETS) $("searchAdd").focus();
    startWorker();   // warm it up while the user picks skills
  }
  function close() { $("searchModal").classList.add("hidden"); if (running) cancel(); }

  function init(appApi) {
    api = appApi;
    fillRaritySelects();
    wireAddBox();
    $("findSetsBtn").addEventListener("click", open);
    $("searchClose").addEventListener("click", close);
    $("searchRun").addEventListener("click", run);
    $("searchCancel").addEventListener("click", cancel);
    $("searchTalMode").addEventListener("change", syncOptionLabels);
    $("searchModal").addEventListener("mousedown", e => { if (e.target === $("searchModal")) close(); });
    // My Talismans
    $("manageTalBtn").addEventListener("click", openTalManager);
    $("talClose").addEventListener("click", () => $("talModal").classList.add("hidden"));
    $("talModal").addEventListener("mousedown", e => { if (e.target === $("talModal")) $("talModal").classList.add("hidden"); });
    $("talAddRar").addEventListener("change", syncTalAddForm);
    $("talAddSk1").addEventListener("change", syncTalAddForm);
    $("talAddSk2").addEventListener("change", syncTalAddForm);
    $("talAddBtn").addEventListener("click", () => addTalisman(readTalForm()));
    $("talFromCurrent").addEventListener("click", () => {
      const cur = api.currentTalisman();
      if (!cur) { $("talAddProblems").textContent = "This set has no talisman on it."; return; }
      addTalisman({ rar: cur.rar, slots: cur.slots, sk: cur.sk.map(e => e.slice()) });
    });
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!$("talModal").classList.contains("hidden")) { $("talModal").classList.add("hidden"); return; }
      if (!$("searchModal").classList.contains("hidden")) close();
    });
  }

  return { init };
})();
