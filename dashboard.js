const state = {
  payload: null,
  selectedKey: null,
  tab: "top",
  grade: "ALL",
  sort: "edge",
  pollTimer: null,
};

const REFRESH_STEPS = [
  "CSStonks universe",
  "Case details",
  "PriceEmpire marketplaces",
  "Case timeseries",
];

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toneClass(label) {
  const value = String(label || "").toLowerCase();
  if (value.includes("good") || value.includes("low") || value === "success") return "good";
  if (value.includes("bad") || value.includes("high") || value === "error" || value.includes("failed")) return "bad";
  return "warn";
}

function fmtNumber(value, digits = 0) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtMoney(value, currency = "USD", digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
  }).format(value);
}

function fmtPct(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Number(value).toFixed(digits)}%`;
}

function fmtScore(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number(value).toFixed(3);
}

function fmtMillions(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value / 1_000_000).toFixed(2)}m`;
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function fmtRelative(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (Math.abs(diffMinutes) < 1) return "now";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 48) return formatter.format(diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.borderColor = isError ? "rgba(239, 123, 104, 0.36)" : "rgba(104, 213, 193, 0.36)";
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function setStatusPill(status) {
  const pill = $("statusPill");
  const health = state.payload?.dashboard?.refreshHealth;
  const stateLabel = status.running
    ? `Running · ${status.currentStep || "starting"}`
    : status.state === "error"
      ? "Refresh error"
      : health?.pricingIncomplete && status.lastSuccessAt
        ? `Ready · pricing incomplete (${health.missingPricingProviders.join(" + ")})`
      : status.lastSuccessAt
        ? `Ready · last success ${fmtRelative(status.lastSuccessAt)}`
        : "Idle";

  const tone = status.running ? "warn" : status.state === "error" || (health?.pricingIncomplete && status.lastSuccessAt) ? "bad" : "good";
  pill.textContent = stateLabel;
  pill.className = `status-pill ${tone}`;
}

function inferProgress(status, config, health) {
  const enabledSteps = REFRESH_STEPS.filter((step) => config?.refresh?.includeTimeseries || step !== "Case timeseries");

  if (status.running) {
    const stepIndex = Math.max(0, enabledSteps.indexOf(status.currentStep));
    const percent = enabledSteps.length ? Math.round((stepIndex / enabledSteps.length) * 100) : 0;
    return {
      headline: "Refresh in progress",
      subline: status.currentStep ? `Now running: ${status.currentStep}` : "Preparing the refresh pipeline.",
      currentStep: status.currentStep || "Starting",
      percent: Math.max(10, Math.min(96, percent)),
      hint: status.currentStep || "Starting",
    };
  }

  if (status.state === "error") {
    return {
      headline: "Last refresh failed",
      subline: status.lastError || "The refresh stopped before finishing.",
      currentStep: "Failed",
      percent: 100,
      hint: "Failed",
    };
  }

  if (status.lastSuccessAt) {
    if (health?.pricingIncomplete) {
      const providers = health.missingPricingProviders.join(" + ") || "pricing providers";
      return {
        headline: "Refresh incomplete",
        subline: `Last run finished, but ${providers} returned no matched prices.`,
        currentStep: "Needs attention",
        percent: 100,
        hint: "Partial data",
      };
    }

    return {
      headline: "Refresh complete",
      subline: `Last successful sync ${fmtRelative(status.lastSuccessAt)}.`,
      currentStep: "Idle",
      percent: 100,
      hint: "Synced",
    };
  }

  return {
    headline: "Ready to refresh",
    subline: "No successful refresh has been recorded yet.",
    currentStep: "Idle",
    percent: 0,
    hint: "Ready",
  };
}

function renderSyncStatus(payload) {
  const progress = inferProgress(payload.status, payload.config, payload.dashboard.refreshHealth);
  $("syncHeadline").textContent = progress.headline;
  $("syncSubline").textContent = progress.subline;
  $("lastSyncedAt").textContent = payload.dashboard.updatedAt
    ? `${fmtDate(payload.dashboard.updatedAt)} (${fmtRelative(payload.dashboard.updatedAt)})`
    : "—";
  $("currentStepLabel").textContent = progress.currentStep;
  $("progressFill").style.width = `${progress.percent}%`;
  $("progressLabel").textContent = `${progress.percent}%`;
  $("progressHint").textContent = progress.hint;
}

function renderHero(payload) {
  const overview = payload.dashboard.overview;
  const status = payload.status;
  $("heroCases").textContent = fmtNumber(overview.totalCases, 0);
  $("heroGrades").textContent = `Green ${overview.goodCount} · Yellow ${overview.warnCount} · Red ${overview.badCount}`;
  $("heroTopCase").textContent = overview.topCandidate ? overview.topCandidate.case : "—";
  $("heroTopMeta").textContent = overview.topCandidate
    ? `Edge ${fmtScore(overview.topCandidate.edge)} · Buy ${fmtScore(overview.topCandidate.buyNow)} · Risk ${fmtScore(overview.topCandidate.risk)}`
    : "Run the pipeline to rank candidates.";
  $("heroPulse").textContent = `${overview.shrinkingCount} shrinking / ${overview.expandingCount} expanding`;
  $("heroPulseMeta").textContent = overview.mood;
  $("heroNextRun").textContent = status.nextRunAt ? fmtRelative(status.nextRunAt) : "Scheduler off";
  $("heroUpdated").textContent = payload.dashboard.updatedAt
    ? `Data updated ${fmtRelative(payload.dashboard.updatedAt)} (${fmtDate(payload.dashboard.updatedAt)})`
    : "No refresh data yet";
}

function applyView(cases) {
  const query = $("searchInput").value.trim().toLowerCase();
  const grade = $("gradeFilter").value;
  const sort = $("sortSelect").value;

  let filtered = [...cases];
  if (query) {
    filtered = filtered.filter((item) => item.case.toLowerCase().includes(query));
  }
  if (grade !== "ALL") {
    filtered = filtered.filter((item) => item.grade.label === grade);
  }

  const sorters = {
    edge: (item) => item.scores.edge ?? -1,
    buyNow: (item) => item.scores.buyNow ?? -1,
    value: (item) => item.scores.value ?? -1,
    scarcity: (item) => item.scores.scarcity ?? -1,
    marketCapUsd: (item) => item.metrics.marketCapUsd ?? -1,
    riskAsc: (item) => item.scores.risk == null ? Number.POSITIVE_INFINITY : item.scores.risk,
  };

  filtered.sort((left, right) => {
    const getter = sorters[sort] || sorters.edge;
    const a = getter(left);
    const b = getter(right);
    return sort === "riskAsc" ? a - b : b - a;
  });

  return filtered;
}

function bar(value) {
  const width = Math.round(((value ?? 0.5) * 100));
  return `<div class="bar"><span style="width:${width}%"></span></div>`;
}

function renderCaseList(payload) {
  const list = $("caseList");
  const cases = applyView(payload.dashboard.cases);
  if (!cases.length) {
    list.innerHTML = `<div class="case-card"><p class="muted">No cases match the current view.</p></div>`;
    return cases;
  }

  if (!cases.some((item) => item.key === state.selectedKey)) {
    state.selectedKey = cases[0].key;
  }

  list.innerHTML = cases.map((item) => {
    const active = item.key === state.selectedKey ? " active" : "";
    return `
      <article class="case-card${active}" data-key="${escapeHtml(item.key)}">
        <div class="case-card-top">
          <div>
            <h4>${escapeHtml(item.case)}</h4>
            <p class="case-meta">#${item.rank} · ${escapeHtml(item.grade.reason)}</p>
          </div>
          <span class="grade-pill ${toneClass(item.grade.label)}">${escapeHtml(item.grade.label)}</span>
        </div>
        <div class="case-score-grid">
          <div>
            <span class="muted">Edge</span>
            <strong>${fmtScore(item.scores.edge)}</strong>
          </div>
          <div>
            <span class="muted">Buy</span>
            <strong>${fmtScore(item.scores.buyNow)}</strong>
          </div>
          <div>
            <span class="muted">Risk</span>
            <strong>${fmtScore(item.scores.risk)}</strong>
          </div>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll(".case-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedKey = card.dataset.key;
      render();
    });
  });

  return cases;
}

function metricCard(label, value, note, score) {
  return `
    <article class="metric-card">
      <span class="muted">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${bar(score)}
      <p class="metric-note">${escapeHtml(note)}</p>
    </article>
  `;
}

function marketCard(label, value, note) {
  return `
    <article class="market-card">
      <span class="muted">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p class="metric-note">${escapeHtml(note)}</p>
    </article>
  `;
}

function marketSnapshotNote(entry) {
  const details = [];
  if (entry?.count != null && Number.isFinite(Number(entry.count))) {
    details.push(`${fmtNumber(entry.count)} offers`);
  }
  const freshness = entry?.lastCheckedAt || entry?.updatedAt;
  if (freshness) {
    details.push(fmtRelative(freshness));
  }
  return details.length ? `PriceEmpire snapshot · ${details.join(" · ")}.` : "PriceEmpire snapshot.";
}

function normalizeSelectedCase(selected) {
  if (!selected) return null;

  const thesis = Array.isArray(selected.thesis) ? selected.thesis : [];
  const risks = Array.isArray(selected.risks) ? selected.risks : [];
  const tags = Array.isArray(selected.tags) ? selected.tags : [];
  const metrics = selected.metrics || {};
  const scores = selected.scores || {};
  const sourceCoverage = selected.sourceCoverage || {};
  const screenshots = selected.screenshots || { chartUrl: null, pageUrl: null, mode: null };
  const market = selected.market || {
    risk: { label: "Unknown", tone: "warn" },
    momentum: { label: "Unknown", tone: "warn" },
  };

  let marketplacePrices = Array.isArray(selected.marketplaces?.prices) ? [...selected.marketplaces.prices] : [];
  if (!marketplacePrices.length) {
    if (metrics.csmoneyEur != null) {
      marketplacePrices.push({ providerName: "CS.MONEY", value: metrics.csmoneyEur });
    }
    if (metrics.csfloatEur != null) {
      marketplacePrices.push({ providerName: "CSFloat", value: metrics.csfloatEur });
    }
  }

  marketplacePrices.sort((left, right) => (left.value ?? Number.POSITIVE_INFINITY) - (right.value ?? Number.POSITIVE_INFINITY));

  return {
    ...selected,
    thesis,
    risks,
    tags,
    metrics,
    scores,
    sourceCoverage: {
      details: !!sourceCoverage.details,
      marketplaces: !!sourceCoverage.marketplaces || marketplacePrices.length > 0,
      marketCount: Number.isFinite(Number(sourceCoverage.marketCount)) ? Number(sourceCoverage.marketCount) : marketplacePrices.length,
      csmoney: !!sourceCoverage.csmoney || metrics.csmoneyEur != null,
      csfloat: !!sourceCoverage.csfloat || metrics.csfloatEur != null,
      chart: !!sourceCoverage.chart || !!screenshots.chartUrl,
    },
    screenshots,
    market: {
      risk: market.risk || { label: "Unknown", tone: "warn" },
      momentum: market.momentum || { label: "Unknown", tone: "warn" },
    },
    marketplaces: {
      prices: marketplacePrices,
    },
  };
}

function renderCoverage(selected) {
  const entries = [
    { label: "Case details", ok: selected.sourceCoverage.details, status: selected.sourceCoverage.details ? "Available" : "Missing" },
    { label: "PriceEmpire", ok: selected.sourceCoverage.marketplaces, status: selected.sourceCoverage.marketplaces ? `${fmtNumber(selected.sourceCoverage.marketCount)} markets` : "Missing" },
    { label: "CS.MONEY", ok: selected.sourceCoverage.csmoney, status: selected.sourceCoverage.csmoney ? "Available" : "Missing" },
    { label: "CSFloat", ok: selected.sourceCoverage.csfloat, status: selected.sourceCoverage.csfloat ? "Available" : "Missing" },
    { label: "Chart capture", ok: selected.sourceCoverage.chart, status: selected.sourceCoverage.chart ? "Available" : "Missing" },
  ];

  return entries.map((entry) => {
    const tone = entry.ok ? "good" : "warn";
    return `<div class="source-card"><span class="source-pill ${tone}">${escapeHtml(entry.label)}</span><span class="muted">${escapeHtml(entry.status)}</span></div>`;
  }).join("");
}

function renderFocus(payload, visibleCases) {
  const selected = normalizeSelectedCase(
    payload.dashboard.cases.find((item) => item.key === state.selectedKey)
      || visibleCases[0]
      || null
  );

  $("focusTitle").textContent = selected ? selected.case : "Choose a case";
  $("focusLink").href = selected ? selected.url : "#";
  $("focusLink").toggleAttribute("aria-disabled", !selected);

  if (!selected) {
    $("focusContent").className = "focus-content empty-state";
    $("focusContent").innerHTML = "<p>No case is selected yet.</p>";
    return;
  }

  const tags = selected.tags.length
    ? `<div class="tag-row">${selected.tags.map((tag) => `<span class="tag ${toneClass(tag)}">${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";

  const chart = selected.screenshots.chartUrl
    ? `<article class="visual-card market-card"><span class="muted">Chart capture</span><img src="${escapeHtml(selected.screenshots.chartUrl)}" alt="${escapeHtml(selected.case)} chart" /></article>`
    : `<article class="market-card"><span class="muted">Chart capture</span><strong>Unavailable</strong><p class="metric-note">No screenshot was saved for this case in the current dataset.</p></article>`;
  const marketplaceCards = selected.marketplaces.prices.length
    ? selected.marketplaces.prices.map((entry) => marketCard(entry.providerName, fmtMoney(entry.value, "EUR"), marketSnapshotNote(entry))).join("")
    : `<article class="market-card"><span class="muted">PriceEmpire</span><strong>Unavailable</strong><p class="metric-note">No marketplace prices were matched for this case in the current snapshot.</p></article>`;

  $("focusContent").className = "focus-content";
  $("focusContent").innerHTML = `
    <section class="focus-hero">
      <div class="focus-band">
        <div class="focus-title-row">
          <h2>${escapeHtml(selected.case)}</h2>
          <span class="grade-pill ${toneClass(selected.grade.label)}">${escapeHtml(selected.grade.label)}</span>
          <span class="score-pill ${toneClass(selected.market.risk.label)}">Risk ${escapeHtml(selected.market.risk.label)}</span>
          <span class="score-pill ${toneClass(selected.market.momentum.tone)}">${escapeHtml(selected.market.momentum.label)}</span>
        </div>
        <p class="summary-blurb">${escapeHtml(selected.grade.reason)}. ${escapeHtml(selected.thesis[0] || "No thesis text yet.")}</p>
        ${tags}
      </div>
      <div class="score-stack">
        <div class="score-pill ${toneClass(selected.grade.label)}"><span>Edge</span><strong>${fmtScore(selected.scores.edge)}</strong></div>
        <div class="score-pill ${toneClass(selected.market.risk.label)}"><span>Buy now</span><strong>${fmtScore(selected.scores.buyNow)}</strong></div>
        <div class="score-pill ${toneClass(selected.market.momentum.tone)}"><span>Conviction</span><strong>${fmtScore(selected.scores.conviction)}</strong></div>
      </div>
    </section>

    <section class="metric-grid">
      ${metricCard("Burn ratio", fmtScore(selected.metrics.burnRatio), "Unboxed divided by dropped supply.", selected.metrics.burnRatio)}
      ${metricCard("Scarcity", fmtScore(selected.scores.scarcity), "Lower remaining supply ranks higher.", selected.scores.scarcity)}
      ${metricCard("Liquidity", fmtScore(selected.scores.liquidity), "Market cap used as liquidity proxy.", selected.scores.liquidity)}
      ${metricCard("Data quality", fmtScore(selected.scores.dataQuality), "Missing sources reduce confidence.", selected.scores.dataQuality)}
      ${metricCard("Remaining", fmtMillions(selected.metrics.remaining), "Current supply on the market.", selected.scores.scarcity)}
      ${metricCard("Steam price", fmtMoney(selected.metrics.steamPriceUsd, "USD"), "Steam market snapshot.", selected.scores.value)}
      ${metricCard("Market cap", fmtMoney(selected.metrics.marketCapUsd, "USD", 0), "Liquidity proxy from CSStonks.", selected.scores.liquidity)}
      ${metricCard("Extinction", selected.metrics.extinctionMonths == null ? "—" : `${selected.metrics.extinctionMonths.toFixed(1)} mo`, "Projected scarcity runway.", selected.scores.extinctionCatalyst)}
    </section>

    <section class="market-grid">
      ${marketCard("Best external", fmtMoney(selected.metrics.externalFloorEur, "EUR"), selected.marketplaces.prices.length ? `Lowest PriceEmpire quote across ${fmtNumber(selected.marketplaces.prices.length)} markets.` : "No marketplace quotes were matched.")}
      ${marketCard("Markets tracked", fmtNumber(selected.marketplaces.prices.length), "Available PriceEmpire marketplace quotes for this case.")}
      ${marketCard("External spread", fmtPct(selected.metrics.externalSpreadPct), "Smaller spread means better marketplace agreement across the tracked markets.")}
      ${marketCard("Momentum windows", [selected.metrics.momentum1m, selected.metrics.momentum6m, selected.metrics.momentum12m].map((value) => fmtPct(value)).join(" / "), "1m / 6m / 12m supply change.")}
      ${marketplaceCards}
    </section>

    <section class="columns-2">
      <article class="focus-band">
        <p class="eyebrow">Bull case</p>
        <h3>What supports the thesis</h3>
        <ul class="clean-list">${selected.thesis.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      </article>
      <article class="focus-band">
        <p class="eyebrow">Watch items</p>
        <h3>What could go wrong</h3>
        <ul class="clean-list">${selected.risks.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      </article>
    </section>

    <section class="columns-2">
      ${chart}
      <article class="market-card">
        <p class="eyebrow">Coverage</p>
        <h3>Source coverage</h3>
        <div class="source-list">
          ${renderCoverage(selected)}
        </div>
      </article>
    </section>
  `;
}

function renderSources(payload) {
  const sourcesList = $("sourcesList");
  const diagnostics = payload.dashboard.diagnostics || [];
  const sourceCards = Object.entries(payload.dashboard.sources).map(([name, source]) => {
    const hasMissingMatches = source.exists !== false && source.matched != null && source.matched === 0;
    const tone = source.exists === false || source.errors > 0 || hasMissingMatches ? (source.exists === false ? "warn" : "bad") : "good";
    const updated = source.timestamp || source.updatedAt;
    const extra = [];
    if (source.scraped != null) extra.push(`${source.scraped} scraped`);
    if (source.matched != null) extra.push(`${source.matched} matched`);
    if (source.providers != null) extra.push(`${source.providers} providers`);
    if (source.errors) extra.push(`${source.errors} errors`);
    if (source.failures) extra.push(`${source.failures} failures`);
    if (source.fallback) extra.push("legacy fallback");
    return `
      <article class="source-card">
        <span class="source-pill ${tone}">${escapeHtml(name)}</span>
        <strong>${source.path ? escapeHtml(source.path) : "—"}</strong>
        <span class="muted">${updated ? `${fmtRelative(updated)} · ${fmtDate(updated)}` : "No timestamp"}</span>
        ${extra.length ? `<span class="muted">${escapeHtml(extra.join(" · "))}</span>` : ""}
      </article>
    `;
  }).join("");

  const diagnosticCards = diagnostics.map((message) => `
    <article class="source-card">
      <span class="source-pill warn">Note</span>
      <span class="muted">${escapeHtml(message)}</span>
    </article>
  `).join("");

  sourcesList.innerHTML = diagnosticCards + sourceCards;
}

function renderLogs(payload) {
  const logList = $("logList");
  const logs = [...(payload.status.logs || [])].slice(-25).reverse();
  if (!logs.length) {
    logList.innerHTML = `<div class="log-line"><span class="muted">No pipeline logs yet.</span></div>`;
    return;
  }

  logList.innerHTML = logs.map((log) => `
    <article class="log-line ${log.level === "error" ? "error" : ""}">
      <time>${fmtDate(log.time)}</time>
      <span>${escapeHtml(log.message)}</span>
    </article>
  `).join("");
}

function renderSnapshots(payload) {
  const snapshotList = $("snapshotList");
  if (!payload.snapshots.length) {
    snapshotList.innerHTML = `<div class="snapshot-card"><span class="muted">No snapshots saved yet.</span></div>`;
    return;
  }

  snapshotList.innerHTML = payload.snapshots.map((snapshot) => `
    <article class="snapshot-card">
      <strong>${escapeHtml(snapshot.name)}</strong>
      <small>${fmtRelative(snapshot.updatedAt)} · ${fmtDate(snapshot.updatedAt)}</small>
      <span class="muted">${escapeHtml(snapshot.files.join(", "))}</span>
    </article>
  `).join("");
}

function syncConfigForm(config) {
  $("cfgSchedulerEnabled").checked = !!config.scheduler.enabled;
  $("cfgIntervalMinutes").value = config.scheduler.intervalMinutes;
  $("cfgRunOnStartup").checked = !!config.scheduler.runOnStartup;
  $("cfgHeadless").checked = !!config.refresh.headless;
  $("cfgPriceLimit").value = config.refresh.priceLimit;
  $("cfgTimeseries").checked = !!config.refresh.includeTimeseries;
  $("cfgStrictness").value = config.analysis.strictness;
  $("cfgStrictnessValue").textContent = config.analysis.strictness;
}

function collectConfigForm() {
  return {
    scheduler: {
      enabled: $("cfgSchedulerEnabled").checked,
      intervalMinutes: Number($("cfgIntervalMinutes").value),
      runOnStartup: $("cfgRunOnStartup").checked,
    },
    refresh: {
      headless: $("cfgHeadless").checked,
      priceLimit: Number($("cfgPriceLimit").value),
      includeTimeseries: $("cfgTimeseries").checked,
    },
    analysis: {
      strictness: Number($("cfgStrictness").value),
    },
  };
}

function setSortForTab(tab) {
  const mapping = {
    top: "edge",
    value: "value",
    risk: "riskAsc",
    liquid: "marketCapUsd",
    scarce: "scarcity",
  };
  state.tab = tab;
  state.sort = mapping[tab] || "edge";
  $("sortSelect").value = state.sort;
}

function render() {
  if (!state.payload) return;
  setStatusPill(state.payload.status);
  renderSyncStatus(state.payload);
  renderHero(state.payload);
  syncConfigForm(state.payload.config);
  const visibleCases = renderCaseList(state.payload);
  renderFocus(state.payload, visibleCases);
  renderSources(state.payload);
  renderLogs(state.payload);
  renderSnapshots(state.payload);
}

async function loadDashboard(silent = false) {
  try {
    const payload = await api("/api/dashboard");
    state.payload = payload;
    render();
  } catch (error) {
    if (!silent) showToast(error.message, true);
  }
}

async function refreshNow() {
  try {
    const result = await api("/api/refresh", { method: "POST", body: "{}" });
    state.payload = state.payload || {};
    state.payload.status = result.status;
    render();
    showToast("Refresh started.");
    setTimeout(() => loadDashboard(true), 1200);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveConfig() {
  try {
    const result = await api("/api/config", {
      method: "POST",
      body: JSON.stringify(collectConfigForm()),
    });
    state.payload.config = result.config;
    state.payload.status = result.status;
    render();
    showToast("Automation saved.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function wire() {
  $("refreshButton").addEventListener("click", refreshNow);
  $("saveConfigButton").addEventListener("click", saveConfig);
  $("cfgStrictness").addEventListener("input", (event) => {
    $("cfgStrictnessValue").textContent = event.target.value;
  });
  $("searchInput").addEventListener("input", render);
  $("gradeFilter").addEventListener("change", render);
  $("sortSelect").addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
      button.classList.add("active");
      setSortForTab(button.dataset.tab);
      render();
    });
  });
}

wire();
setSortForTab("top");
loadDashboard();
state.pollTimer = setInterval(() => loadDashboard(true), 10000);
