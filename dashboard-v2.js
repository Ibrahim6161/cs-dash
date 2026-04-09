const state = {
  payload: null,
  steamSession: null,
  portfolio: null,
  portfolioLoading: false,
  selectedKey: null,
  liveMarket: new Map(),
  loadingMarketKey: null,
  liveFillQueue: new Set(),
  liveRefreshTimer: null,
  liveRefreshCursor: 0,
  steamQueue: [],
  steamQueueTimer: null,
  steamBackoffUntil: 0,
  lastRenderedKeys: [],
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNumber(value, digits = 0) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtMoney(value, currency = "EUR", digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
  }).format(value);
}

function fmtPct(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(digits)}%`;
}

function fmtScore(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return (value * 100).toFixed(0);
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
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 48) return formatter.format(diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function toneClass(label) {
  const value = String(label || "").toLowerCase();
  if (value.includes("good")) return "good";
  if (value.includes("bad")) return "bad";
  return "warn";
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.borderColor = isError ? "rgba(255, 117, 102, 0.36)" : "rgba(88, 184, 255, 0.36)";
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
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function chartSvg(values, color = "#58b8ff") {
  const points = (Array.isArray(values) ? values : []).filter((value) => value != null && Number.isFinite(value));
  if (!points.length) {
    return `<div class="muted">No chart data.</div>`;
  }
  const width = 640;
  const height = 190;
  const padding = 18;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((value, index) => {
    const x = padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
    const y = height - padding - ((value - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="fill-${color.replace("#", "")}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.36"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <polyline fill="none" stroke="${color}" stroke-width="3" points="${coords.join(" ")}"></polyline>
    </svg>
  `;
}

function driverCard(driver) {
  return `
    <article class="metric-card">
      <span>${escapeHtml(driver.label)}</span>
      <strong>${escapeHtml(driver.valueText)}</strong>
      <p class="muted">${escapeHtml(driver.note)}</p>
      <div class="metric-pill ${toneClass(driver.tone)}">${escapeHtml(driver.tone.toUpperCase())}</div>
    </article>
  `;
}

function getResolvedSteamPrice(item) {
  const live = state.liveMarket.get(item.key);
  return live?.overview?.lowestPriceEur
    ?? live?.overview?.medianPriceEur
    ?? live?.summary?.latestPriceEur
    ?? item.price.steamPriceEur
    ?? null;
}

function getResolvedSteamTrend(item) {
  const live = state.liveMarket.get(item.key);
  return live?.summary?.change30dPct ?? item.metrics.steamChange30dPct ?? null;
}

function queueSteamItems(items, prioritize = false) {
  const next = items.filter((item) =>
    item
    && !state.liveMarket.has(item.key)
    && !state.liveFillQueue.has(item.key)
    && item.price.steamPriceEur == null
    && !state.steamQueue.some((queued) => queued.key === item.key)
  );

  if (!next.length) return;
  state.steamQueue = prioritize
    ? [...next, ...state.steamQueue]
    : [...state.steamQueue, ...next];
}

function startSteamQueue() {
  if (state.steamQueueTimer) return;
  state.steamQueueTimer = setInterval(async () => {
    if (!state.steamQueue.length) return;
    if (Date.now() < state.steamBackoffUntil) return;

    const item = state.steamQueue.shift();
    if (!item || state.liveMarket.has(item.key) || state.liveFillQueue.has(item.key)) return;

    state.liveFillQueue.add(item.key);
    try {
      const payload = await api(`/api/item-market?name=${encodeURIComponent(item.name)}`);
      state.liveMarket.set(item.key, payload.market);
      state.steamBackoffUntil = Date.now() + 1200;
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("429") || message.includes("502")) {
        state.steamBackoffUntil = Date.now() + 5000;
        state.steamQueue.push(item);
      }
    } finally {
      state.liveFillQueue.delete(item.key);
      render();
    }
  }, 1500);
}

function compareCard(label, value, note) {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p class="muted">${escapeHtml(note)}</p>
    </article>
  `;
}

function getInvestmentThesis(item) {
  const points = [];
  if (item.metrics.steamDiscountPct != null && item.metrics.steamDiscountPct >= 20) {
    points.push("SkinBaron is meaningfully below Steam");
  }
  if (item.isCase && item.metrics.burnRatio != null && item.metrics.burnRatio >= 0.7) {
    points.push("burn ratio is strong");
  }
  if (item.isCase && item.metrics.momentum12m != null && item.metrics.momentum12m < 0) {
    points.push("supply is still shrinking");
  }
  if (item.price.steamVolume != null && item.price.steamVolume >= 500) {
    points.push("Steam liquidity is usable");
  }
  if (item.metrics.extinctionMonths != null && item.metrics.extinctionMonths <= 72) {
    points.push("scarcity window is visible");
  }
  if (!points.length) {
    return "Mixed setup. The score is usable, but the edge depends more on execution than on one dominant signal.";
  }
  return `Main thesis: ${points.join(", ")}.`;
}

function buildInvestmentCards(item) {
  const cards = [
    compareCard("Steam floor", fmtMoney(getResolvedSteamPrice(item)), "Live Steam sale starting at price."),
    compareCard("SkinBaron floor", fmtMoney(item.price.skinbaronFloorEur), "Cheapest external entry in the current scrape."),
    compareCard("Entry gap", fmtPct(item.metrics.steamDiscountPct), "Positive means the outside market is cheaper than Steam."),
    compareCard("Steam 30d", fmtPct(getResolvedSteamTrend(item)), "Recent price direction on Steam."),
    compareCard("Liquidity", item.price.steamVolume != null ? `${fmtNumber(item.price.steamVolume)} volume` : "—", "Higher volume means easier exits."),
  ];

  if (item.isCase) {
    cards.push(
      compareCard("Burn ratio", item.metrics.burnRatio != null ? item.metrics.burnRatio.toFixed(2) : "—", "Higher burn supports the scarcity case."),
      compareCard("12m supply", fmtPct(item.metrics.momentum12m), "Negative means supply kept shrinking."),
      compareCard("Remaining supply", item.metrics.remaining != null ? fmtNumber(item.metrics.remaining) : "—", "Current remaining tracked supply."),
      compareCard("Extinction", item.metrics.extinctionMonths != null ? `${item.metrics.extinctionMonths.toFixed(1)} mo` : "—", "How long the scarcity path could take at the current pace.")
    );
  } else {
    cards.push(
      compareCard("Confidence", `${fmtScore(item.scores.confidence)}%`, "How complete the read is across sources."),
      compareCard("Category", item.category.label, "Container type used for grouping."),
      compareCard("Score", `${fmtScore(item.scores.total)} / 100`, "Overall investment read."),
      compareCard("Risk", `${fmtScore(item.scores.risk)} / 100`, "Lower is better.")
    );
  }

  return cards.join("");
}

function renderStatus(payload) {
  const status = payload.status;
  const pill = $("statusPill");
  pill.className = `status-pill ${status.state === "error" ? "bad" : status.running ? "warn" : "good"}`;
  pill.textContent = status.running
    ? `Running · ${status.currentStep || "starting"}`
    : status.state === "error"
      ? "Refresh error"
      : status.lastSuccessAt
        ? `Ready · ${fmtRelative(status.lastSuccessAt)}`
        : "Idle";

  $("lastSyncedAt").textContent = payload.dashboard.updatedAt
    ? `${fmtDate(payload.dashboard.updatedAt)}`
    : "No sync yet";

  const percent = status.running ? 55 : status.state === "error" ? 100 : payload.dashboard.updatedAt ? 100 : 0;
  $("progressFill").style.width = `${percent}%`;
  $("progressLabel").textContent = `${percent}%`;
  $("progressHint").textContent = status.running ? (status.currentStep || "Running") : status.state === "error" ? "Failed" : "Ready";
  $("syncHeadline").textContent = status.running ? "Refresh in progress" : status.state === "error" ? "Last refresh failed" : "Refresh complete";
  $("syncSubline").textContent = status.lastError || (payload.dashboard.updatedAt ? `Updated ${fmtRelative(payload.dashboard.updatedAt)}.` : "No refresh activity yet.");
}

function renderHero(payload) {
  const overview = payload.dashboard.overview;
  $("heroUniverse").textContent = fmtNumber(overview.totalItems);
  $("heroUniverseMeta").textContent = `${fmtNumber(overview.totalCases)} cases · ${fmtNumber(overview.marketOnlyCount)} non-case items`;
  $("heroTopName").textContent = overview.topCandidate?.name || "—";
  $("heroTopMeta").textContent = overview.topCandidate
    ? `${overview.topCandidate.category} · score ${fmtScore(overview.topCandidate.score)} · risk ${fmtScore(1 - overview.topCandidate.risk)}`
    : "No ranking yet";
  $("heroDiscount").textContent = overview.bestDiscount?.name || "—";
  $("heroDiscountMeta").textContent = overview.bestDiscount?.change30dPct != null
    ? `30d trend ${fmtPct(overview.bestDiscount.change30dPct)}`
    : "Need Steam coverage";
  $("heroTrend").textContent = overview.strongestSteamTrend?.name || "—";
  $("heroTrendMeta").textContent = overview.strongestSteamTrend?.change30dPct != null
    ? fmtPct(overview.strongestSteamTrend.change30dPct)
    : "Need Steam coverage";
}

function applyView(items) {
  const query = $("searchInput").value.trim().toLowerCase();
  const category = $("categoryFilter").value;
  const grade = $("gradeFilter").value;
  const sort = $("sortSelect").value;

  let filtered = [...items];
  if (query) filtered = filtered.filter((item) => item.name.toLowerCase().includes(query));
  if (category !== "ALL") filtered = filtered.filter((item) => item.category.key === category);
  if (grade !== "ALL") filtered = filtered.filter((item) => item.grade.label === grade);

  const sorters = {
    score: (item) => item.scores.total ?? -1,
    discount: (item) => item.metrics.steamDiscountPct ?? -999,
    trend: (item) => item.metrics.steamChange30dPct ?? -999,
    liquidity: (item) => item.price.steamVolume ?? -1,
    scarcity: (item) => item.scores.scarcity ?? -1,
  };

  filtered.sort((left, right) => (sorters[sort]?.(right) ?? 0) - (sorters[sort]?.(left) ?? 0));
  return filtered;
}

function renderList(payload) {
  const list = $("caseList");
  const items = applyView(payload.dashboard.items);
  if (!items.length) {
    list.innerHTML = `<div class="item-row"><p class="muted">No items match the current filters.</p></div>`;
    return items;
  }

  if (!items.some((item) => item.key === state.selectedKey)) {
    state.selectedKey = items[0].key;
  }

  list.innerHTML = items.map((item) => `
    <article class="item-row${item.key === state.selectedKey ? " active" : ""}" data-key="${escapeHtml(item.key)}">
      <div class="item-top">
        <div>
          <h3 class="item-title">${escapeHtml(item.name)}</h3>
          <div class="item-meta">
            <span class="category-pill">${escapeHtml(item.category.label)}</span>
            <span class="grade-pill ${toneClass(item.grade.label)}">${escapeHtml(item.grade.label)}</span>
          </div>
        </div>
        <div class="metric-pill ${toneClass(item.grade.label)}">${fmtScore(item.scores.total)}</div>
      </div>
      <div class="score-row">
        <div class="score-cell">
          <span>Steam</span>
          <strong>${fmtMoney(getResolvedSteamPrice(item))}</strong>
        </div>
        <div class="score-cell">
          <span>SkinBaron</span>
          <strong>${fmtMoney(item.price.skinbaronFloorEur)}</strong>
        </div>
        <div class="score-cell">
          <span>30d</span>
          <strong>${fmtPct(getResolvedSteamTrend(item))}</strong>
        </div>
      </div>
      <p class="muted">${escapeHtml(item.grade.reason)}</p>
    </article>
  `).join("");

  list.querySelectorAll(".item-row").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedKey = row.dataset.key;
      render();
      ensureLiveMarket();
    });
  });

  state.lastRenderedKeys = items.map((item) => item.key);
  hydrateVisibleSteam(items);
  return items;
}

async function ensureLiveMarket() {
  const item = state.payload?.dashboard?.items?.find((entry) => entry.key === state.selectedKey);
  if (!item || state.liveMarket.has(item.key) || state.loadingMarketKey === item.key) return;
  state.loadingMarketKey = item.key;
  queueSteamItems([item], true);
  render();
  try {
    const payload = await api(`/api/item-market?name=${encodeURIComponent(item.name)}`);
    state.liveMarket.set(item.key, payload.market);
  } finally {
    state.loadingMarketKey = null;
    render();
  }
}

async function hydrateVisibleSteam(items) {
  queueSteamItems(items, false);
}

async function refreshVisibleSteam(items) {
  queueSteamItems(items, false);
}

function scheduleLiveSteamRefresh() {
  if (state.liveRefreshTimer) {
    clearInterval(state.liveRefreshTimer);
  }

  state.liveRefreshTimer = setInterval(() => {
    if (!state.payload?.dashboard?.items?.length) return;
    const filtered = state.lastRenderedKeys.length
      ? state.payload.dashboard.items.filter((item) => state.lastRenderedKeys.includes(item.key))
      : applyView(state.payload.dashboard.items);
    if (!filtered.length) return;

    const batchSize = 8;
    const start = state.liveRefreshCursor % filtered.length;
    const rotating = [];
    for (let index = 0; index < Math.min(batchSize, filtered.length); index += 1) {
      rotating.push(filtered[(start + index) % filtered.length]);
    }
    state.liveRefreshCursor = (start + batchSize) % filtered.length;

    const selected = state.payload.dashboard.items.find((item) => item.key === state.selectedKey);
    const targets = selected
      ? [selected, ...rotating.filter((item) => item.key !== selected.key)]
      : rotating;
    refreshVisibleSteam(targets);
  }, 10000);
}

function renderSources(payload) {
  $("sourcesList").innerHTML = Object.values(payload.dashboard.sources).map((source) => `
    <article class="source-card">
      <span class="source-pill ${source.exists === false ? "bad" : "good"}">${escapeHtml(source.label)}</span>
      <strong>${escapeHtml(source.path || "—")}</strong>
      <span class="muted">${source.timestamp ? `${fmtRelative(source.timestamp)} · ${fmtDate(source.timestamp)}` : "No timestamp"}</span>
      ${source.matched != null ? `<span class="muted">${fmtNumber(source.matched)} matched</span>` : ""}
    </article>
  `).join("");
}

function renderLogs(payload) {
  const logs = [...(payload.status.logs || [])].slice(-12).reverse();
  $("logList").innerHTML = logs.length
    ? logs.map((log) => `
      <article class="log-line">
        <strong>${escapeHtml(log.message)}</strong>
        <span class="muted">${fmtDate(log.time)}</span>
      </article>
    `).join("")
    : `<div class="log-line"><span class="muted">No logs yet.</span></div>`;
}

function renderPortfolio() {
  const button = $("steamConnectButton");
  const refreshButton = $("steamRefreshButton");
  const session = state.steamSession;
  const summary = $("portfolioSummary");
  const list = $("portfolioList");

  if (!session?.connected) {
    button.textContent = "Connect Steam";
    button.href = "/auth/steam/login";
    button.dataset.mode = "connect";
    refreshButton.disabled = true;
    summary.innerHTML = `
      <strong>Steam not connected</strong>
      <span class="muted">Connect your public Steam inventory to see holdings.</span>
    `;
    list.innerHTML = "";
    return;
  }

  button.textContent = "Disconnect Steam";
  button.href = "#";
  button.dataset.mode = "disconnect";
  refreshButton.disabled = state.portfolioLoading;

  if (state.portfolioLoading) {
    summary.innerHTML = `
      <strong>Loading Steam inventory...</strong>
      <span class="muted">Reading public CS2 inventory for ${escapeHtml(session.profile?.personaName || "your account")}.</span>
    `;
    list.innerHTML = "";
    return;
  }

  if (!state.portfolio) {
    summary.innerHTML = state.portfolioError
      ? `
      <strong>Inventory kon niet geladen worden</strong>
      <span class="muted">${escapeHtml(state.portfolioError)}</span>
      <span class="muted">Zet je Steam inventory op public en klik daarna op Refresh inventory.</span>
    `
      : `
      <strong>Connected as ${escapeHtml(session.profile?.personaName || session.profile?.steamId || "Steam account")}</strong>
      <span class="muted">Inventory is connected but not loaded yet.</span>
    `;
    list.innerHTML = "";
    return;
  }

  summary.innerHTML = `
    <strong>${fmtMoney(state.portfolio.totals.estimatedValueEur)} estimated value</strong>
    <span class="muted">${fmtNumber(state.portfolio.totals.uniqueItems)} unique items · ${fmtNumber(state.portfolio.totals.totalQuantity)} total units</span>
    <span class="muted">${fmtNumber(state.portfolio.totals.matchedItems)} matched to the dashboard pricing layer</span>
    <span class="muted">${escapeHtml(state.portfolio.profile?.personaName || "Steam account")} � ${state.portfolio.cached ? "cached" : "fresh"} � ${fmtRelative(state.portfolio.fetchedAt)}</span>
  `;

  const items = state.portfolio.items.slice(0, 16);
  list.innerHTML = items.length
    ? items.map((item) => `
      <article class="portfolio-item">
        ${item.iconUrl
          ? `<img src="${escapeHtml(item.iconUrl)}" alt="" />`
          : `<div class="score-cell"></div>`}
        <div>
          <p class="portfolio-name">${escapeHtml(item.name)}</p>
          <div class="portfolio-meta">
            <span class="category-pill">${escapeHtml(item.dashboardItem?.category?.label || item.type || "Steam item")}</span>
            <span class="metric-pill ${item.matched ? "good" : "warn"}">${item.matched ? "Matched" : "Live only"}</span>
            <span class="metric-pill">x${fmtNumber(item.quantity)}</span>
            ${item.tradable === false ? `<span class="metric-pill warn">Trade locked</span>` : ""}
          </div>
        </div>
        <div class="portfolio-values">
          <strong>${fmtMoney(item.totalPriceEur)}</strong>
          <span class="muted">${fmtMoney(item.unitPriceEur)} each</span>
        </div>
      </article>
    `).join("")
    : `<div class="log-line"><span class="muted">No marketable CS2 items found in this inventory.</span></div>`;
}

function renderFocus(payload, visibleItems) {
  const item = payload.dashboard.items.find((entry) => entry.key === state.selectedKey) || visibleItems[0];
  if (!item) {
    $("focusContent").className = "empty-state";
    $("focusContent").innerHTML = "<p>No item selected.</p>";
    return;
  }

  const live = state.liveMarket.get(item.key);
  const loading = state.loadingMarketKey === item.key;
  const buyRows = live?.orderbook?.buyLevels?.slice(0, 5) || [];
  const sellRows = live?.orderbook?.sellLevels?.slice(0, 5) || [];

  $("focusContent").className = "detail-shell";
  $("focusContent").innerHTML = `
    <section class="focus-band">
      <div class="detail-top">
        <div class="detail-title">
          <p class="eyebrow">${escapeHtml(item.category.label)}</p>
          <h2>${escapeHtml(item.name)}</h2>
          <div class="detail-headline">
            <span class="grade-pill ${toneClass(item.grade.label)}">${escapeHtml(item.grade.label)}</span>
            <span class="metric-pill ${toneClass(item.grade.label)}">Score ${fmtScore(item.scores.total)}</span>
            <span class="metric-pill warn">Entry ${fmtScore(item.scores.entry)}</span>
            <span class="metric-pill ${item.scores.risk <= 0.35 ? "good" : item.scores.risk >= 0.65 ? "bad" : "warn"}">Risk ${fmtScore(item.scores.risk)}</span>
            <span class="metric-pill ${item.scores.confidence >= 0.75 ? "good" : "warn"}">Confidence ${fmtScore(item.scores.confidence)}</span>
          </div>
          <p class="detail-summary">${escapeHtml(getInvestmentThesis(item))}</p>
        </div>
        <div class="detail-actions">
          ${item.urls.csstonks ? `<a class="button" href="${escapeHtml(item.urls.csstonks)}" target="_blank" rel="noopener">CSStonks</a>` : ""}
          ${item.urls.steam ? `<a class="button" href="${escapeHtml(item.urls.steam)}" target="_blank" rel="noopener">Steam</a>` : ""}
          ${item.urls.skinbaron ? `<a class="button" href="${escapeHtml(item.urls.skinbaron)}" target="_blank" rel="noopener">SkinBaron</a>` : ""}
        </div>
      </div>
    </section>

    <section class="score-grid">
      ${buildInvestmentCards(item)}
    </section>

    <section class="charts-grid">
      <article class="chart-card">
        <span>Steam chart</span>
        <h3>${loading ? "Loading live Steam data…" : "Recent price history"}</h3>
        <div class="chart-shell">${chartSvg(live?.history?.map((point) => point.price) || item.charts.steam, "#58b8ff")}</div>
        <div class="chart-meta">
          <span class="muted">Sale starting at ${fmtMoney(live?.overview?.lowestPriceEur ?? item.price.steamPriceEur)}</span>
          <span class="muted">7d ${fmtPct(live?.summary?.change7dPct ?? item.metrics.steamChange7dPct)}</span>
          <span class="muted">30d ${fmtPct(live?.summary?.change30dPct ?? item.metrics.steamChange30dPct)}</span>
        </div>
      </article>
      <article class="chart-card">
        <span>Steam orderbook</span>
        <h3>${live?.orderbook ? "Best buy / sell depth" : "Loads live when selected"}</h3>
        <div class="market-list">
          <div class="market-row"><strong>Best sell</strong><strong>${fmtMoney(live?.orderbook?.lowestSellEur)}</strong></div>
          <div class="market-row"><strong>Best buy</strong><strong>${fmtMoney(live?.orderbook?.highestBuyEur)}</strong></div>
          <div class="market-row"><strong>Spread</strong><strong>${fmtPct(live?.orderbook?.spreadPct)}</strong></div>
        </div>
        <div class="market-list">
          ${sellRows.map((row) => `<div class="market-row"><span>Sell ${fmtMoney(row.priceEur)}</span><span>${fmtNumber(row.quantity)}</span></div>`).join("") || `<span class="muted">No live orderbook yet.</span>`}
        </div>
      </article>


    </section>

    <section class="detail-grid">
      <article class="chart-card">
        <span>CSStonks activity</span>
        <h3>${item.isCase ? "Historical unboxings" : "No CSStonks coverage"}</h3>
        <div class="chart-shell">${chartSvg(item.charts.activity, "#59d484")}</div>
        <div class="chart-meta">
          <span class="muted">Burn ratio ${item.metrics.burnRatio != null ? item.metrics.burnRatio.toFixed(2) : "—"}</span>
          <span class="muted">12m supply ${fmtPct(item.metrics.momentum12m)}</span>
          <span class="muted">Extinction ${item.metrics.extinctionMonths != null ? `${item.metrics.extinctionMonths.toFixed(1)} mo` : "—"}</span>
        </div>
      </article>

      <article class="chart-card">
        <span>Decision notes</span>
        <h3>What matters for the entry</h3>
        <div class="market-list">
          ${item.thesis.map((line) => `<div class="market-row"><span>${escapeHtml(line)}</span></div>`).join("")}
        </div>
        <h3 style="margin-top:14px;">What can break it</h3>
        <div class="market-list">
          ${item.risks.map((line) => `<div class="market-row"><span>${escapeHtml(line)}</span></div>`).join("")}
        </div>
      </article>
    </section>
  `;
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

function render() {
  if (!state.payload) {
    renderPortfolio();
    return;
  }
  renderStatus(state.payload);
  renderHero(state.payload);
  syncConfigForm(state.payload.config);
  const visible = renderList(state.payload);
  renderFocus(state.payload, visible);
  renderSources(state.payload);
  renderLogs(state.payload);
  renderPortfolio();
}

async function loadDashboard(silent = false) {
  try {
    state.payload = await api("/api/dashboard");
    render();
    ensureLiveMarket();
  } catch (error) {
    if (!silent) showToast(error.message, true);
  }
}

async function loadSteamSession(silent = false) {
  try {
    const payload = await api("/api/steam/auth/status");
    state.steamSession = payload;
    renderPortfolio();
    if (state.steamSession?.connected) {
      loadPortfolio(silent);
    } else {
      state.portfolio = null;
    }
  } catch (error) {
    if (!silent) showToast(error.message, true);
  }
}

async function loadPortfolio(silent = false, forceRefresh = false) {
  if (!state.steamSession?.connected || state.portfolioLoading) return;
  state.portfolioLoading = true;
  renderPortfolio();
  try {
    const payload = await api(`/api/steam/inventory${forceRefresh ? "?refresh=1" : ""}`);
    state.portfolio = payload;
    state.portfolioError = null;
  } catch (error) {
    state.portfolio = null;
    if (!silent) showToast(error.message, true);
  } finally {
    state.portfolioLoading = false;
    renderPortfolio();
  }
}
async function disconnectSteam() {
  try {
    await api("/api/steam/logout", { method: "POST", body: "{}" });
    state.steamSession = { connected: false, profile: null };
    state.portfolio = null;
    renderPortfolio();
    showToast("Steam disconnected.");
  } catch (error) {
    showToast(error.message, true);
  }
}


async function refreshNow() {
  try {
    await api("/api/refresh", { method: "POST", body: "{}" });
    showToast("Refresh started.");
    setTimeout(() => loadDashboard(true), 1200);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveConfig() {
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify(collectConfigForm()),
    });
    showToast("Automation saved.");
    loadDashboard(true);
  } catch (error) {
    showToast(error.message, true);
  }
}

function wire() {
  $("refreshButton").addEventListener("click", refreshNow);
  $("saveConfigButton").addEventListener("click", saveConfig);
  $("steamRefreshButton").addEventListener("click", () => loadPortfolio(false, true));
  $("steamConnectButton").addEventListener("click", async (event) => {
    if (event.currentTarget.dataset.mode !== "disconnect") return;
    event.preventDefault();
    try {
      await api("/api/steam/logout", { method: "POST", body: "{}" });
      state.steamSession = { ok: true, connected: false, profile: null };
      state.portfolio = null;
      showToast("Steam disconnected.");
      renderPortfolio();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("cfgStrictness").addEventListener("input", (event) => {
    $("cfgStrictnessValue").textContent = event.target.value;
  });
  $("searchInput").addEventListener("input", render);
  $("categoryFilter").addEventListener("change", render);
  $("gradeFilter").addEventListener("change", render);
  $("sortSelect").addEventListener("change", render);
}

function bootSteamFeedback() {
  const params = new URLSearchParams(window.location.search);
  const steam = params.get("steam");
  const steamError = params.get("steam_error");
  if (steam === "connected") {
    showToast("Steam connected.");
  } else if (steam === "disconnected") {
    showToast("Steam disconnected.");
  } else if (steamError) {
    showToast(steamError, true);
  }
  if (steam || steamError) {
    params.delete("steam");
    params.delete("steam_error");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }
}

wire();
startSteamQueue();
bootSteamFeedback();
loadSteamSession();
loadDashboard();
scheduleLiveSteamRefresh();
setInterval(() => loadDashboard(true), 10000);
setInterval(() => loadSteamSession(true), 60000);
















