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

  let api = null;
  let targets = [];          // [{tree, pts, name}] — no arbitrary limit on how many
  let lastResults = [];      // everything the search returned
  let viewResults = [];      // what the sort/filter controls currently show
  let lastTargets = [];      // the skills asked for, to tell bonuses apart
  let worker = null, workerReady = false, running = false;
  let lastLiveRender = 0;    // throttles redrawing while a search streams in
  let probing = false;       // a follow-up "would another talisman work?" check
  const RES_NAMES = ["Fire", "Water", "Thunder", "Ice", "Dragon"];

  // Every positive activated skill, for the typeahead.
  const OPTIONS = [];
  for (const [treeStr, ladder] of Object.entries(window.SB_SKILLS.active))
    for (const [pts, name] of ladder) if (pts > 0) OPTIONS.push({ tree: Number(treeStr), pts, name });
  OPTIONS.sort((a, b) => a.name.localeCompare(b.name));

  // A talisman is points and slots; where it drops is not something to plan a
  // set around. One the user entered keeps the name they chose. One the search
  // produced is named by its TIER, never by a specific talisman: those rolls
  // are available from every rarity in the tier, so calling it a "Hero
  // Talisman" would claim a precision it does not have.
  const talLabel = (t, withTier) => {
    const skills = t.sk.map(([tr, p]) => `${treeName(tr)} ${p > 0 ? "+" + p : p}`).join(", ");
    const slots = `${t.slots} slot${t.slots === 1 ? "" : "s"}`;
    if (t.gen) return withTier ? `${window.SBUI.tierName(t.rar)} tier — ${skills}, ${slots}` : `${skills}, ${slots}`;
    return `${window.SB_CHARM.names[t.rar] || "Talisman"} — ${skills}, ${slots}`;
  };

  // ── Targets: a stationary add box, chips collect below it ──────────────
  function renderTargets() {
    const wrap = $("searchTargets");
    wrap.innerHTML = targets.map((t, i) =>
      `<span class="skill-chip target-chip" data-i="${i}" title="Remove">
        ${esc(t.name)} <span class="tc-sub">(${esc(treeName(t.tree))} ${t.pts})</span> ✕</span>`).join("");
    wrap.querySelectorAll(".target-chip").forEach(chip =>
      chip.addEventListener("click", () => { targets.splice(Number(chip.dataset.i), 1); renderTargets(); }));
    // Each extra skill costs search time, so say so once it starts to matter —
    // but nothing stops you adding more.
    $("searchAddHint").textContent = targets.length >= 6
      ? `${targets.length} skills — demanding queries may stop early.` : "";
  }
  function wireAddBox() {
    const inp = $("searchAdd"), list = $("searchAddList");
    // Matching is deliberately forgiving. The community spells several of
    // these differently from the data ("Sheathe Control" for Sheath Control),
    // and a skill you cannot type is a skill you cannot search for. Every word
    // must match somewhere, but a word counts if either side merely starts the
    // other — so "sheathe" finds "Sheath", and "crit" finds "Critical".
    const matches = (o, words) => {
      const hay = (o.name + " " + treeName(o.tree)).toLowerCase();
      if (hay.includes(words.join(" "))) return true;
      const parts = hay.split(/[^a-z0-9+]+/).filter(Boolean);
      return words.every(w =>
        parts.some(p => p.startsWith(w) || w.startsWith(p)) || hay.includes(w));
    };
    const refresh = () => {
      const q = inp.value.trim().toLowerCase();
      if (!q) { list.classList.add("hidden"); return; }
      const words = q.split(/\s+/).filter(Boolean);
      const hits = OPTIONS.filter(o =>
        !targets.some(t => t.tree === o.tree) && matches(o, words)).slice(0, 12);
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
          inp.focus();   // stay put, keep typing
        }));
    };
    inp.addEventListener("input", refresh);
    inp.addEventListener("focus", refresh);
    inp.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
  }

  // ── Options ────────────────────────────────────────────────────────────
  function fillRaritySelects() {
    // Only the My Talismans form needs a rarity: it is how a real talisman's
    // legal skills and ranges are checked. The search itself never asks.
    $("talAddRar").innerHTML = Object.entries(window.SB_CHARM.names)
      .map(([id, n]) => `<option value="${id}">${esc(n)} (R${id})</option>`).join("");
    $("talAddRar").value = "10";
  }
  function syncOptionLabels() {
    const auto = api.weaponArmorClass();
    $("searchClass").options[0].text = `Auto (${auto === "G" ? "Gunner" : auto === "B" ? "Blademaster" : "no weapon → Blademaster"})`;
    $("searchWSlots").options[0].text = `Auto (${api.currentWeaponSlots()})`;
    const mine = $("searchTalMode").value === "mine";
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
      : window.SBSearch.generateTalismans(trees, window.SB_CHARM, { twoSkill: mode === "two" });
    return {
      gender: Number($("searchGender").value),
      cls: clsSel === "auto" ? (auto || "B") : clsSel,
      maxRar: Number($("searchRar").value),
      weaponSlots: slotSel === "auto" ? api.currentWeaponSlots() : Number(slotSel),
      villageStar: Number($("searchVillage").value),
      hubStar: Number($("searchHub").value),
      talismans,
    };
  }
  // Village runs to 10 stars, the Gathering Hall to 13. Both default to the
  // end of the game so an untouched search covers everything.
  function fillProgressionSelects() {
    const opts = (n, label) => {
      let h = "";
      for (let i = n; i >= 1; i--) h += `<option value="${i}">${i}★${i === n ? " (all)" : ""}</option>`;
      return h;
    };
    $("searchVillage").innerHTML = opts(10);
    $("searchHub").innerHTML = opts(13);
    $("searchVillage").value = "10";
    $("searchHub").value = "13";
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
      worker = new Worker("search-worker.js?v=2");
      workerReady = false;
      worker.onmessage = e => {
        const m = e.data || {};
        if (m.type === "ready") { workerReady = true; return; }
        if (m.type === "progress") {
          if (probing || !running) return;
          // Keep what has been found so far, so it survives a cancel and can
          // be looked at while the rest of the search runs.
          if (m.fresh && m.fresh.length) {
            lastResults = lastResults.concat(m.fresh);
            if (!lastTargets.length) lastTargets = targets.map(t => [t.tree, t.pts]);
            // Redrawing on every report would thrash a long search; once a
            // second is enough to watch it fill up.
            const now = performance.now();
            if (now - lastLiveRender > 1000) {
              lastLiveRender = now;
              $("searchResultTools").classList.remove("hidden");
              buildFilterOptions();
              applyView();
            }
          }
          $("searchStatus").textContent =
            `Searching… ${m.found} found, ${m.explored.toLocaleString()} sets checked. Cancel keeps what it has.`;
          return;
        }
        if (m.type === "done") {
          if (probing) { finishProbe(m.res); return; }
          finishSearch(m.res);
          return;
        }
        if (m.type === "error") {
          if (probing) { probing = false; return; }
          finishSearch(null, m.message);
          return;
        }
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
    // Up to 1000 results — enough variety without chasing full exhaustiveness,
    // which for an easy query could mean thousands of near-duplicate sets for
    // no benefit. Most queries reach that cap in well under a second.
    //
    // The five-minute ceiling is a backstop against a search that would never
    // end, not the expected wait: hard queries stream their sets out as they
    // are found and Cancel keeps them, so nobody has to sit and watch a bar to
    // get an answer.
    const query = { targets: targets.map(t => [t.tree, t.pts]), maxResults: 1000, timeBudgetMs: 300000, ...opts };
    running = true;
    searchStart = performance.now();
    lastResults = [];
    viewResults = [];
    lastTargets = targets.map(t => [t.tree, t.pts]);
    lastLiveRender = 0;
    $("searchRun").disabled = true;
    $("searchCancel").classList.remove("hidden");
    $("searchResultTools").classList.add("hidden");
    $("searchResults").innerHTML = "";
    document.querySelectorAll(".search-suggest").forEach(n => n.remove());
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
  // Cancelling keeps everything the search had reached. The worker is torn
  // down rather than asked to stop — a synchronous search cannot answer
  // messages while it runs — which is why results are streamed out as they
  // are found rather than handed over at the end.
  function cancel() {
    if (!running) return;
    killWorker();
    running = false;
    $("searchRun").disabled = false;
    $("searchCancel").classList.add("hidden");
    const ms = Math.round(performance.now() - searchStart);
    if (lastResults.length) {
      $("searchResultTools").classList.remove("hidden");
      buildFilterOptions();
      applyView();
      $("searchStatus").textContent =
        `Stopped after ${(ms / 1000).toFixed(1)} s — keeping the ${lastResults.length} set(s) found so far.`;
    } else {
      $("searchStatus").textContent = `Stopped after ${(ms / 1000).toFixed(1)} s — nothing found yet.`;
    }
  }
  function finishSearch(res, err) {
    running = false;
    $("searchRun").disabled = false;
    $("searchCancel").classList.add("hidden");
    const ms = Math.round(performance.now() - searchStart);
    if (err || !res) { $("searchStatus").textContent = `Search failed: ${err || "no result"}.`; return; }
    lastResults = res.results;
    lastTargets = targets.map(t => [t.tree, t.pts]);
    $("searchResultTools").classList.toggle("hidden", !res.results.length);
    if (res.results.length) buildFilterOptions();
    const talMode = $("searchTalMode").value;
    const hint = talMode === "mine" && !api.getTalismans().length
      ? " No talismans stored yet — only talisman-free sets were considered."
      : "";
    const partial = !res.complete;
    // A talisman category can genuinely be unable to reach a combination —
    // e.g. a one-skill talisman can't cover two skills that need a shared
    // slot, even though a two-skill one could. That is a real, checked answer
    // (the search tried every combination and none worked), not a stall, so
    // it gets its own message rather than reading like the search gave up.
    const otherModes = talMode === "one" ? `"Any — two skills" or your own talismans`
      : talMode === "two" ? `your own talismans` : `a generated talisman`;
    $("searchStatus").textContent = res.results.length
      ? `${res.results.length} set(s) in ${ms} ms.${partial
          ? " Stopped early — there are more; narrow the skills or allow weapon slots." : ""}${hint}`
      : partial
        ? `No sets found before stopping at ${(ms / 1000).toFixed(1)} s — these skills are demanding. Try fewer, or allow weapon slots.${hint}`
        // Only claim everything was checked when it actually was: the Soul
        // passes run on a short allowance and may have been cut short.
        : `No possible set reaches those skills this way — ${res.soulTruncated ? "nearly every" : "every"} combination with ${talMode === "mine" ? "your stored talismans" : talMode === "one" ? "a one-skill talisman (or none)" : "a two-skill talisman (or none)"} was checked.${hint}`;
    applyView();
    // Finding nothing is usually not the end of the story — a two-skill
    // talisman often reaches what a one-skill one cannot. Rather than tell
    // people to go and try it, go and try it: this asks for a single set, so
    // it answers in a fraction of the time a full search takes.
    if (!res.results.length && talMode !== "two") probeOtherTalismans();
  }

  // "Nothing found" with a one-skill talisman rarely means nothing exists —
  // every set tested so far for five or six skills needed a two-skill charm.
  // Asking for a single set answers that in a fraction of a full search, and
  // the offer to re-run is one click.
  // What to try, in order of how easy it is to actually do. Spending weapon
  // slots comes first: a decorable weapon is a choice, while a two-skill charm
  // is a hunt. This matters — Sheath Control has no jewel at all and no piece
  // gives more than 2, so that set lives or dies on where its slots come from.
  let probeQueue = [];
  function probeOtherTalismans() {
    if (!worker) return;
    const opts = currentOptions();
    const trees = targets.map(t => t.tree);
    const base = { ...opts, targets: targets.map(t => [t.tree, t.pts]),
      maxResults: 1, timeBudgetMs: 20000, soulBudgetMs: 2000 };
    probeQueue = [];
    // Fewest extra slots first, so the answer is the least weapon it takes —
    // telling someone they need a 3-slot weapon when a 1-slot one would do
    // sends them hunting for gear they do not need.
    for (let ws = opts.weaponSlots + 1; ws <= 3; ws++) probeQueue.push({
      query: { ...base, weaponSlots: ws },
      describe: () => `A weapon with ${ws} slot${ws === 1 ? "" : "s"} would reach these skills, `
        + `with the talismans you are already asking for.`,
      apply: () => { $("searchWSlots").value = String(ws); },
      button: `Search with a ${ws}-slot weapon`,
    });
    if ($("searchTalMode").value !== "two") probeQueue.push({
      query: { ...base, talismans: window.SBSearch.generateTalismans(trees, window.SB_CHARM, { twoSkill: true }) },
      describe: r => {
        const tal = r.set.talisman;
        return `A two-skill talisman can reach these skills — for example <b>${esc(tal ? talLabel(tal) : "one you have")}</b>.`;
      },
      apply: () => { $("searchTalMode").value = "two"; syncOptionLabels(); },
      button: "Search with two-skill talismans",
    });
    nextProbe();
  }
  function nextProbe() {
    if (!probeQueue.length || !worker) { probing = false; return; }
    probing = true;
    worker.postMessage({ type: "search", query: probeQueue[0].query });
  }
  function finishProbe(res) {
    const step = probeQueue.shift();
    if (!res || !res.results.length) { nextProbe(); return; }   // try the next relaxation
    probing = false;
    probeQueue = [];
    document.querySelectorAll(".search-suggest").forEach(n => n.remove());
    const note = document.createElement("div");
    note.className = "search-suggest";
    note.innerHTML = `${step.describe(res.results[0])} `
      + `<button id="searchProbeApply" class="nav-btn">${esc(step.button)}</button>`;
    $("searchStatus").parentNode.after(note);
    $("searchProbeApply").addEventListener("click", () => {
      step.apply();
      note.remove();
      run();
    });
  }

  // With up to 1000 results, a rich row-per-result with a listener-per-button
  // is the wrong shape — Athena's own tool renders results as one plain-text
  // block for exactly this reason. This keeps the click-to-apply interaction
  // (worth keeping — it's most of the point of the search) but pays for it
  // cheaply: one compact line of text per row, ONE delegated click listener
  // for the whole list instead of one per button, and rows are added a page
  // at a time so the DOM never holds more than what's been asked to see.
  const RESULTS_PAGE = 100;
  let shown = 0;

  // ── Bonus skills ───────────────────────────────────────────────────────
  // Two kinds, both worked out per row as it is drawn rather than during the
  // search: skills the set already grants beyond what was asked for, and
  // skills that spare slots could still reach. The second is the useful one —
  // it's how you notice a set is one jewel away from something you'd want.
  // Cached on the result so scrolling and re-sorting never recompute it.
  function bonusesOf(r) {
    if (r._bonus) return r._bonus;
    const asked = new Set(lastTargets.map(t => t[0]));
    const active = r.engine.active
      .filter(a => !a.negative && !a.soul && !asked.has(a.tree))
      .map(a => a.name);
    // Spare slots, biggest first — a 3-slot hole can take any jewel.
    const holes = [];
    for (const [, s] of Object.entries(r.engine.slots)) {
      const free = s.total - s.used;
      if (free > 0) holes.push(free);
    }
    const reachable = [];
    if (holes.length) {
      const biggest = Math.max(...holes);
      const totalFree = holes.reduce((a, b) => a + b, 0);
      for (const [treeStr, pts] of Object.entries(r.engine.treePoints)) {
        const tree = Number(treeStr);
        if (pts <= 0 || asked.has(tree)) continue;
        const ladder = window.SB_SKILLS.active[tree];
        if (!ladder) continue;
        const next = ladder.find(s => s[0] > 0 && s[0] > pts);
        if (!next) continue;
        // Best jewel for this skill that would actually fit a free hole.
        let best = 0;
        for (const d of Object.values(window.SB_DECOS)) {
          if (d.slots > biggest) continue;
          const sk = d.sk.find(([tr, p]) => tr === tree && p > 0);
          if (sk && sk[1] > best) best = sk[1];
        }
        if (!best) continue;
        const shortBy = next[0] - pts;
        const jewels = Math.ceil(shortBy / best);
        if (jewels * 1 <= totalFree && jewels <= holes.length)
          reachable.push({ name: next[1], jewels });
      }
      reachable.sort((a, b) => a.jewels - b.jewels);
    }
    r._bonus = { active, reachable: reachable.slice(0, 3) };
    return r._bonus;
  }

  // ── Sort / filter — pure array work over what the search already returned;
  // none of this ever re-runs a search.
  const SORTS = {
    best: (a, b) => a.talCost - b.talCost || b.spare - a.spare || b.defense - a.defense,
    def: (a, b) => b.defense - a.defense || b.spare - a.spare,
    defmax: (a, b) => b.engine.defenseMax - a.engine.defenseMax || b.spare - a.spare,
    slots: (a, b) => b.spare - a.spare || b.defense - a.defense,
    rar: (a, b) => maxRarOf(b) - maxRarOf(a) || b.defense - a.defense,
  };
  for (let i = 0; i < 5; i++)
    SORTS["res" + i] = (a, b) => b.engine.res[i] - a.engine.res[i] || b.defense - a.defense;
  const maxRarOf = r => {
    if (r._maxRar === undefined)
      r._maxRar = Math.max(...["head", "chest", "arms", "waist", "legs"]
        .map(s => window.SB_ARMOR[s][r.set.pieces[s].id].rar));
    return r._maxRar;
  };
  const rowText = r => {
    if (r._text === undefined)
      r._text = (["head", "chest", "arms", "waist", "legs"]
        .map(s => window.SB_ARMOR[s][r.set.pieces[s].id].n).join(" ")
        + " " + r.engine.active.map(a => a.name).join(" ")).toLowerCase();
    return r._text;
  };
  function applyView() {
    const talSel = $("searchFilterTal").value;
    const bonusSel = $("searchFilterBonus").value;
    const text = $("searchFilterText").value.trim().toLowerCase();
    viewResults = lastResults.filter(r => {
      if (talSel !== "*") {
        const key = r.set.talisman ? talLabel(r.set.talisman) : "";
        if (key !== talSel) return false;
      }
      if (bonusSel !== "*" && !bonusesOf(r).active.includes(bonusSel)) return false;
      if (text && !rowText(r).includes(text)) return false;
      return true;
    });
    const cmp = SORTS[$("searchSort").value] || SORTS.best;
    viewResults.sort(cmp);
    $("searchShowing").textContent = viewResults.length === lastResults.length
      ? `${lastResults.length} set(s)`
      : `${viewResults.length} of ${lastResults.length} set(s)`;
    renderResults();
  }
  // The filter dropdowns list only what the results actually contain, so a
  // choice can never come back empty.
  function buildFilterOptions() {
    const tals = new Map();
    const bonuses = new Set();
    for (const r of lastResults) {
      const key = r.set.talisman ? talLabel(r.set.talisman) : "";
      tals.set(key, (tals.get(key) || 0) + 1);
      for (const b of bonusesOf(r).active) bonuses.add(b);
    }
    const talOpts = [...tals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    $("searchFilterTal").innerHTML = `<option value="*">Any</option>`
      + talOpts.map(([k, n]) =>
        `<option value="${esc(k)}">${k ? esc(k) : "None needed"} (${n})</option>`).join("");
    $("searchFilterBonus").innerHTML = `<option value="*">Any</option>`
      + [...bonuses].sort().map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
    $("searchFilterText").value = "";
    $("searchSort").value = "best";
  }

  // With up to 1000 results, a rich row-per-result with a listener-per-button
  // is the wrong shape — Athena's own tool renders results as one plain-text
  // block for exactly this reason. This keeps the click-to-apply interaction
  // (worth keeping — it's most of the point of the search) but pays for it
  // cheaply: one compact line of text per row, ONE delegated click listener
  // for the whole list instead of one per button, and rows are added a page
  // at a time so the DOM never holds more than what's been asked to see.
  const TRACKER_URL = "https://armoredraven17.github.io/mhgu-collection-tracker/";
  const rowHtml = (r, i) => {
    const pieces = ["head", "chest", "arms", "waist", "legs"].map(slot => {
      const a = window.SB_ARMOR[slot][r.set.pieces[slot].id];
      // Straight to that piece in the Collection Tracker, where its materials
      // and upgrade costs already live — no need to duplicate them here.
      return `<a class="srl-piece" href="${TRACKER_URL}#a:${slot}/${r.set.pieces[slot].id}"`
        + ` target="_blank" rel="noopener" title="Materials and costs in the Collection Tracker">${esc(a.n)}</a>`;
    }).join(" · ");
    const decoCount = Object.values(r.set.pieces).reduce((n, p) => n + p.decos.length, 0)
      + (r.set.weapon ? r.set.weapon.decos.length : 0)
      + (r.set.talisman ? r.set.talisman.decos.length : 0);
    const neg = r.engine.active.filter(a => a.negative);
    const talText = r.set.talisman ? esc(talLabel(r.set.talisman)) : "no talisman";
    const bonus = bonusesOf(r);
    const res = r.engine.res.map((v, k) =>
      `<span class="srl-res ${v > 0 ? "pos" : v < 0 ? "neg" : ""}" title="${RES_NAMES[k]}">${v > 0 ? "+" + v : v}</span>`).join("");
    return `<div class="search-result-line" data-i="${i}">`
      + `<span class="srl-set">${pieces}</span>`
      + `<span class="srl-sk">${r.engine.active.filter(a => !a.negative).map(a => esc(a.name)).join(", ")}`
      + (neg.length ? ` <span class="sr-neg">${neg.map(a => esc(a.name)).join(", ")}</span>` : "")
      + (bonus.active.length ? `<span class="srl-bonus"> +${bonus.active.map(esc).join(", ")}</span>` : "")
      + (bonus.reachable.length
        ? `<span class="srl-reach"> ${bonus.reachable.map(b =>
            `${esc(b.name)} (${b.jewels} jwl away)`).join(", ")}</span>` : "")
      + `</span>`
      + `<span class="srl-tal">${talText}</span>`
      + `<span class="srl-stat">Def ${r.defense}<span class="srl-resgroup">${res}</span>${decoCount} deco · ${r.spare} free</span>`
      + `<button class="nav-btn" data-apply="${i}">Apply</button></div>`;
  };
  function renderResults() {
    shown = 0;
    $("searchResults").innerHTML = "";
    appendPage();
  }
  function appendPage() {
    const wrap = $("searchResults");
    const next = viewResults.slice(shown, shown + RESULTS_PAGE);
    wrap.querySelector(".srl-more")?.remove();
    wrap.insertAdjacentHTML("beforeend", next.map((r, k) => rowHtml(r, shown + k)).join(""));
    shown += next.length;
    if (shown < viewResults.length)
      wrap.insertAdjacentHTML("beforeend",
        `<button class="nav-btn srl-more" id="searchShowMore">Show ${Math.min(RESULTS_PAGE, viewResults.length - shown)} more (of ${viewResults.length})</button>`);
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
          <div class="pr-main"><div class="pr-name">${esc(talLabel(t, true))}</div></div>
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
    $("searchAdd").focus();
    startWorker();   // warm it up while the user picks skills
  }
  function close() { $("searchModal").classList.add("hidden"); if (running) cancel(); }

  function init(appApi) {
    api = appApi;
    fillRaritySelects();
    fillProgressionSelects();
    wireAddBox();
    $("findSetsBtn").addEventListener("click", open);
    $("searchClose").addEventListener("click", close);
    $("searchRun").addEventListener("click", run);
    $("searchCancel").addEventListener("click", cancel);
    $("searchTalMode").addEventListener("change", syncOptionLabels);
    // Sorting and filtering only ever re-arrange results already in hand —
    // they never start a search.
    $("searchSort").addEventListener("change", applyView);
    $("searchFilterTal").addEventListener("change", applyView);
    $("searchFilterBonus").addEventListener("change", applyView);
    $("searchFilterText").addEventListener("input", applyView);
    // One delegated listener for the whole results list — apply a set, or
    // load the next page — instead of one per row, which matters once a
    // search can return up to 1000 of them.
    $("searchResults").addEventListener("click", e => {
      const applyBtn = e.target.closest("[data-apply]");
      if (applyBtn) { api.applyFoundSet(viewResults[Number(applyBtn.dataset.apply)].set); close(); return; }
      if (e.target.id === "searchShowMore") appendPage();
    });
    $("searchModal").addEventListener("mousedown", e => { if (e.target === $("searchModal")) close(); });
    // My Talismans
    $("manageTalBtn").addEventListener("click", openTalManager);
    $("talClose").addEventListener("click", () => $("talModal").classList.add("hidden"));
    $("talModal").addEventListener("mousedown", e => { if (e.target === $("talModal")) $("talModal").classList.add("hidden"); });
    $("talAddRar").addEventListener("change", syncTalAddForm);
    $("talAddSk1").addEventListener("change", syncTalAddForm);
    $("talAddSk2").addEventListener("change", syncTalAddForm);
    $("talAddBtn").addEventListener("click", () => addTalisman(readTalForm()));
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!$("talModal").classList.contains("hidden")) { $("talModal").classList.add("hidden"); return; }
      if (!$("searchModal").classList.contains("hidden")) close();
    });
  }

  return { init };
})();
