const state = {
  payload: null,
  portfolio: null,
  portfolioLoading: false,
  portfolioError: null,
  portfolioQuery: "",
  selectedCaseKey: null,
  selectedSkinKey: null,
  activeTab: "cases",
  liveMarket: new Map(),
  loadingMarketKey: null,
  steamQueue: [],
  liveFillQueue: new Set(),
  steamBackoffUntil: 0,
  steamQueueTimer: null,
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
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString(undefined, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
}

function fmtMoney(value, currency = "EUR", digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function fmtPct(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtScore(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return (Number(value) * 100).toFixed(0);
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

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.borderColor = isError
    ? "rgba(255, 111, 111, 0.28)"
    : "rgba(90, 183, 255, 0.28)";
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 2400);
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
  const points = (Array.isArray(values) ? values : []).filter(
    (value) => value != null && Number.isFinite(value)
  );

  if (!points.length) {
    return `<div class="empty-state">No chart data available.</div>`;
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
      <polyline
        fill="none"
        stroke="${color}"
        stroke-width="3"
        points="${coords.join(" ")}"
      ></polyline>
    </svg>
  `;
}

function getCaseItems() {
  return Array.isArray(state.payload?.dashboard?.items) ? state.payload.dashboard.items : [];
}

function getSkinItems() {
  return Array.isArray(state.payload?.dashboard?.skins) ? state.payload.dashboard.skins : [];
}

function getResolvedSteamPrice(item) {
  const live = state.liveMarket.get(item.key);
  return live?.overview?.lowestPriceEur
    ?? live?.overview?.medianPriceEur
    ?? live?.summary?.latestPriceEur
    ?? item.price?.steamPriceEur
    ?? item.steamPriceEur
    ?? item.unitPriceEur
    ?? null;
}

function getResolvedTrend(item) {
  const live = state.liveMarket.get(item.key);
  return live?.summary?.change30dPct
    ?? item.metrics?.steamChange30dPct
    ?? item.change30dPct
    ?? null;
}

function queueSteamItems(items, prioritize = false) {
  const next = items.filter((item) =>
    item &&
    item.key &&
    item.name &&
    !state.liveMarket.has(item.key) &&
    !state.liveFillQueue.has(item.key) &&
    !state.steamQueue.some((queued) => queued.key === item.key)
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
    if (!item || !item.name || state.liveFillQueue.has(item.key) || state.liveMarket.has(item.key)) return;

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

function renderHero(payload) {
  const cases = getCaseItems();
  const skins = getSkinItems();
  const overview = payload.dashboard.overview || {};

  $("heroUniverse").textContent = fmtNumber((cases.length || 0) + (skins.length || 0));
  $("lastSyncedAt").textContent = payload.dashboard.updatedAt ? fmtDate(payload.dashboard.updatedAt) : "—";

  $("heroTopName").textContent = overview.topCandidate?.name || cases[0]?.name || "—";
  $("heroTopMeta").textContent = overview.topCandidate
    ? `${overview.topCandidate.category} · score ${fmtScore(overview.topCandidate.score)}`
    : "No ranking yet";

  const mostLiquid = [...cases].sort((a, b) => (b.price?.steamVolume ?? -1) - (a.price?.steamVolume ?? -1))[0];
  $("heroDiscount").textContent = mostLiquid?.name || "—";
  $("heroDiscountMeta").textContent = mostLiquid?.price?.steamVolume != null
    ? `${fmtNumber(mostLiquid.price.steamVolume)} listings`
    : "Waiting for Steam coverage";

  $("heroTrend").textContent = skins.length ? fmtNumber(skins.length) : "—";
  $("heroTrendMeta").textContent = skins.length ? "Scrape-fed skin universe ready" : "Waiting for skin scrape";

  $("statUniverse").textContent = fmtNumber((cases.length || 0) + (skins.length || 0));
  $("statUniverseMeta").textContent = `${fmtNumber(cases.length)} cases · ${fmtNumber(skins.length)} skins`;

  $("statCases").textContent = fmtNumber(cases.length);
  $("statCasesMeta").textContent = "Steam-priced case dataset";

  $("statSkins").textContent = fmtNumber(skins.length);
  $("statSkinsMeta").textContent = "Steam-priced skin dataset";

  $("statGood").textContent = fmtNumber(overview.goodCount);
  $("statGoodMeta").textContent = `${fmtNumber(overview.warnCount)} watch · ${fmtNumber(overview.badCount)} risky`;
}

function renderStatus(payload) {
  const status = payload.status;
  $("statusPill").textContent = status.running
    ? `Running · ${status.currentStep || "starting"}`
    : status.state === "error"
      ? "Refresh error"
      : status.lastSuccessAt
        ? `Ready · ${fmtRelative(status.lastSuccessAt)}`
        : "Idle";

  const percent = status.running ? 55 : status.state === "error" ? 100 : payload.dashboard.updatedAt ? 100 : 0;
  $("progressFill").style.width = `${percent}%`;
  $("progressLabel").textContent = `${percent}%`;
  $("progressHint").textContent = status.running
    ? (status.currentStep || "Running")
    : status.state === "error"
      ? "Failed"
      : "Ready";

  $("syncHeadline").textContent = status.running
    ? "Refresh in progress"
    : status.state === "error"
      ? "Last refresh failed"
      : "Refresh complete";

  $("syncSubline").textContent = status.lastError
    || (payload.dashboard.updatedAt ? `Updated ${fmtRelative(payload.dashboard.updatedAt)}.` : "No refresh activity yet.");
}

function applyCaseFilters(items) {
  const query = $("searchInput").value.trim().toLowerCase();
  const category = $("categoryFilter").value;
  const grade = $("gradeFilter").value;
  const sort = $("sortSelect").value;

  let filtered = [...items];

  if (query) {
    filtered = filtered.filter((item) => String(item.name || "").toLowerCase().includes(query));
  }

  if (category !== "ALL") {
    filtered = filtered.filter((item) => item.category?.key === category);
  }

  if (grade !== "ALL") {
    filtered = filtered.filter((item) => item.grade?.label === grade);
  }

  const sorters = {
    score: (item) => item.scores?.total ?? -1,
    listings: (item) => item.price?.steamVolume ?? -1,
    price: (item) => item.price?.steamPriceEur ?? -1,
    scarcity: (item) => item.scores?.scarcity ?? -1,
  };

  filtered.sort((a, b) => (sorters[sort]?.(b) ?? 0) - (sorters[sort]?.(a) ?? 0));
  return filtered;
}

function renderCaseList(items) {
  $("caseResultsMeta").textContent = `${fmtNumber(items.length)} visible cases`;

  const target = $("caseList");
  if (!items.length) {
    target.innerHTML = `<div class="empty-state">No cases match the current filters.</div>`;
    $("caseDetail").innerHTML = `<div class="empty-state">No case selected.</div>`;
    return;
  }

  if (!items.some((item) => item.key === state.selectedCaseKey)) {
    state.selectedCaseKey = items[0].key;
  }

  target.innerHTML = items.map((item) => `
    <article class="list-item ${item.key === state.selectedCaseKey ? "is-active" : ""}" data-key="${escapeHtml(item.key)}">
      <div class="list-item-top">
        <div>
          <h3 class="list-item-title">${escapeHtml(item.name)}</h3>
          <div class="badge-row">
            <span class="category-pill">${escapeHtml(item.category?.label || "Case")}</span>
            <span class="grade-pill ${String(item.grade?.tone || "warn")}">${escapeHtml(item.grade?.label || "WARN")}</span>
          </div>
        </div>
        <div class="score-badge">${fmtScore(item.scores?.total)}</div>
      </div>

      <div class="score-row">
        <div class="score-cell">
          <span>Steam</span>
          <strong>${fmtMoney(getResolvedSteamPrice(item))}</strong>
        </div>
        <div class="score-cell">
          <span>Listings</span>
          <strong>${fmtNumber(item.price?.steamVolume)}</strong>
        </div>
        <div class="score-cell">
          <span>Burn</span>
          <strong>${item.metrics?.burnRatio != null ? item.metrics.burnRatio.toFixed(2) : "—"}</strong>
        </div>
      </div>

      <p class="list-item-copy">${escapeHtml(item.grade?.reason || item.summary || "Mixed setup")}</p>
    </article>
  `).join("");

  target.querySelectorAll(".list-item").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedCaseKey = node.dataset.key;
      render();
      const picked = items.find((item) => item.key === state.selectedCaseKey);
      if (picked) queueSteamItems([picked], true);
    });
  });

  renderCaseDetail(items);
}

function renderCaseDetail(items) {
  const selected = items.find((item) => item.key === state.selectedCaseKey) || items[0];
  const target = $("caseDetail");

  if (!selected) {
    target.innerHTML = `<div class="empty-state">No case selected.</div>`;
    return;
  }

  const live = state.liveMarket.get(selected.key);
  const steamChart = live?.history?.map((point) => point.price) || selected.charts?.steam || [];
  const activityChart = selected.charts?.activity || [];

  target.innerHTML = `
    <section class="case-hero">
      <div class="case-hero-inner">
        <div class="case-hero-media">
          ${selected.media?.iconUrl ? `<img src="${escapeHtml(selected.media.iconUrl)}" alt="" />` : ""}
        </div>

        <div class="case-hero-copy">
          <div class="eyebrow">${escapeHtml(selected.category?.label || "Case")}</div>
          <h2>${escapeHtml(selected.name)}</h2>

          <div class="hero-badges">
            <span class="grade-pill ${String(selected.grade?.tone || "warn")}">${escapeHtml(selected.grade?.label || "WARN")}</span>
            <span class="metric-pill">Score ${fmtScore(selected.scores?.total)}</span>
            <span class="metric-pill">Entry ${fmtScore(selected.scores?.entry)}</span>
            <span class="metric-pill">Risk ${fmtScore(selected.scores?.risk)}</span>
            <span class="metric-pill">Confidence ${fmtScore(selected.scores?.confidence)}</span>
          </div>

          <p>${escapeHtml(selected.summary || "Steam-first case setup")}</p>
        </div>

        <div class="hero-side-actions">
          ${selected.urls?.csstonks ? `<a class="btn btn-secondary" href="${escapeHtml(selected.urls.csstonks)}" target="_blank" rel="noopener">CSStonks</a>` : ""}
          ${selected.urls?.steam ? `<a class="btn btn-primary" href="${escapeHtml(selected.urls.steam)}" target="_blank" rel="noopener">Steam listing</a>` : ""}
        </div>
      </div>
    </section>

    <section class="metrics-grid">
      ${metricCard("Steam price", fmtMoney(getResolvedSteamPrice(selected)), "Taken from steam-cases.json or live Steam market")}
      ${metricCard("Listings", fmtNumber(selected.price?.steamVolume), "Steam sell listing count")}
      ${metricCard("Burn ratio", selected.metrics?.burnRatio != null ? selected.metrics.burnRatio.toFixed(2) : "—", "Higher historical consumption is better")}
      ${metricCard("12m supply", selected.metrics?.momentum12m != null ? fmtPct(selected.metrics.momentum12m) : "—", "Negative means supply kept shrinking")}
      ${metricCard("Remaining supply", selected.metrics?.remaining != null ? fmtNumber(selected.metrics.remaining) : "—", "Current tracked remaining supply")}
      ${metricCard("Extinction", selected.metrics?.extinctionMonths != null ? `${selected.metrics.extinctionMonths.toFixed(1)} mo` : "—", "Projected scarcity horizon")}
    </section>

    <section class="two-col-grid">
      <article class="panel-card">
        <h3>Supply and activity</h3>
        <div class="chart-shell">${chartSvg(activityChart, "#35d07f")}</div>
        <div class="market-list" style="margin-top:14px;">
          <div class="market-row"><span>Burn ratio</span><strong>${selected.metrics?.burnRatio != null ? selected.metrics.burnRatio.toFixed(2) : "—"}</strong></div>
          <div class="market-row"><span>12m supply</span><strong>${selected.metrics?.momentum12m != null ? fmtPct(selected.metrics.momentum12m) : "—"}</strong></div>
          <div class="market-row"><span>Remaining</span><strong>${selected.metrics?.remaining != null ? fmtNumber(selected.metrics.remaining) : "—"}</strong></div>
        </div>
      </article>

      <article class="panel-card">
        <h3>Steam market</h3>
        <div class="chart-shell">${chartSvg(steamChart, "#58b8ff")}</div>
        <div class="market-list" style="margin-top:14px;">
          <div class="market-row"><span>Current Steam price</span><strong>${fmtMoney(getResolvedSteamPrice(selected))}</strong></div>
          <div class="market-row"><span>30d trend</span><strong>${fmtPct(getResolvedTrend(selected))}</strong></div>
          <div class="market-row"><span>Listings</span><strong>${fmtNumber(selected.price?.steamVolume)}</strong></div>
        </div>
      </article>
    </section>

    <section class="two-col-grid">
      <article class="panel-card">
        <h3>Investment thesis</h3>
        <div class="market-list">
          ${(selected.thesis || []).map((line) => `<div class="market-row"><span>${escapeHtml(line)}</span></div>`).join("")}
        </div>
      </article>

      <article class="panel-card">
        <h3>Main risks</h3>
        <div class="market-list">
          ${(selected.risks || []).map((line) => `<div class="market-row"><span>${escapeHtml(line)}</span></div>`).join("")}
        </div>
      </article>
    </section>

    ${(selected.screenshots?.chartUrl || selected.screenshots?.pageUrl) ? `
      <section class="screenshot-grid">
        ${selected.screenshots?.chartUrl ? `
          <article class="screenshot-card">
            <span>Chart screenshot</span>
            <img src="${escapeHtml(selected.screenshots.chartUrl)}" alt="" />
          </article>
        ` : ""}
        ${selected.screenshots?.pageUrl ? `
          <article class="screenshot-card">
            <span>Page screenshot</span>
            <img src="${escapeHtml(selected.screenshots.pageUrl)}" alt="" />
          </article>
        ` : ""}
      </section>
    ` : ""}
  `;
}

function metricCard(label, value, note) {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(note)}</p>
    </article>
  `;
}

function populateSkinTypeFilters(items) {
  const types = [...new Set(items.map((item) => String(item.type || item.category || "Other")).filter(Boolean))].sort();
  const html = [`<option value="ALL">All</option>`, ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)].join("");

  const currentA = $("skinTypeFilter").value || "ALL";
  const currentB = $("skinTypeFilterWide").value || "ALL";

  $("skinTypeFilter").innerHTML = html;
  $("skinTypeFilterWide").innerHTML = html;

  $("skinTypeFilter").value = types.includes(currentA) ? currentA : "ALL";
  $("skinTypeFilterWide").value = types.includes(currentB) ? currentB : $("skinTypeFilter").value;
}

function syncSkinFiltersFromSidebar() {
  $("skinSearchInputWide").value = $("skinSearchInput").value;
  $("skinTypeFilterWide").value = $("skinTypeFilter").value;
  $("skinMarketableFilterWide").value = $("skinMarketableFilter").value;
  $("skinSortSelectWide").value = $("skinSortSelect").value;
}

function syncSkinFiltersFromContent() {
  $("skinSearchInput").value = $("skinSearchInputWide").value;
  $("skinTypeFilter").value = $("skinTypeFilterWide").value;
  $("skinMarketableFilter").value = $("skinMarketableFilterWide").value;
  $("skinSortSelect").value = $("skinSortSelectWide").value;
}

function applySkinFilters(items) {
  const search = $("skinSearchInput").value.trim().toLowerCase();
  const typeFilter = $("skinTypeFilter").value;
  const marketableFilter = $("skinMarketableFilter").value;
  const tradableFilter = $("skinTradableFilterWide").value;
  const sort = $("skinSortSelect").value;

  let filtered = [...items];

  if (search) {
    filtered = filtered.filter((item) => String(item.name || "").toLowerCase().includes(search));
  }

  if (typeFilter !== "ALL") {
    filtered = filtered.filter((item) => String(item.type || item.category || "Other") === typeFilter);
  }

  if (marketableFilter === "MARKETABLE") {
    filtered = filtered.filter((item) => item.marketable !== false);
  } else if (marketableFilter === "NON_MARKETABLE") {
    filtered = filtered.filter((item) => item.marketable === false);
  }

  if (tradableFilter === "TRADABLE") {
    filtered = filtered.filter((item) => item.tradable !== false);
  } else if (tradableFilter === "LOCKED") {
    filtered = filtered.filter((item) => item.tradable === false);
  }

  const sorters = {
    value_desc: (a, b) => (getResolvedSteamPrice(b) ?? -1) - (getResolvedSteamPrice(a) ?? -1),
    value_asc: (a, b) => (getResolvedSteamPrice(a) ?? 1e15) - (getResolvedSteamPrice(b) ?? 1e15),
    qty_desc: (a, b) => (b.quantity ?? 1) - (a.quantity ?? 1),
    name_asc: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
    name_desc: (a, b) => String(b.name || "").localeCompare(String(a.name || "")),
  };

  filtered.sort(sorters[sort] || sorters.value_desc);
  return filtered;
}

function renderSkins() {
  const allSkins = getSkinItems();
  populateSkinTypeFilters(allSkins);

  const visible = applySkinFilters(allSkins);
  $("skinResultsMeta").textContent = `${fmtNumber(visible.length)} visible skins`;

  $("skinsVisibleCount").textContent = fmtNumber(visible.length);
  $("skinsTotalCount").textContent = fmtNumber(allSkins.length);
  $("skinsMarketableCount").textContent = fmtNumber(allSkins.filter((item) => item.marketable !== false).length);

  const priced = visible.map((item) => getResolvedSteamPrice(item)).filter((value) => value != null && Number.isFinite(value));
  const avg = priced.length ? priced.reduce((sum, value) => sum + value, 0) / priced.length : null;
  $("skinsAvgPrice").textContent = fmtMoney(avg);

  const grid = $("skinsGrid");
  if (!visible.length) {
    $("skinHero").innerHTML = `<div class="empty-state">No skins match the current filters.</div>`;
    grid.innerHTML = `<div class="empty-state">No skins to display.</div>`;
    return;
  }

  if (!visible.some((item) => item.key === state.selectedSkinKey)) {
    state.selectedSkinKey = visible[0].key;
  }

  const selected = visible.find((item) => item.key === state.selectedSkinKey) || visible[0];
  renderSkinHero(selected);

  grid.innerHTML = visible.map((item) => `
    <article class="skin-card ${item.key === state.selectedSkinKey ? "is-active" : ""}" data-key="${escapeHtml(item.key)}">
      <div class="skin-card-top">
        <div class="skin-card-media">
          ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="" loading="lazy" />` : ""}
        </div>

        <div>
          <h3 class="skin-card-title">${escapeHtml(item.name)}</h3>
          <div class="skin-card-tags">
            <span class="category-pill">${escapeHtml(item.type || item.category || "Other")}</span>
            <span class="metric-pill ${item.marketable !== false ? "good" : "warn"}">${item.marketable !== false ? "Marketable" : "No market"}</span>
            <span class="metric-pill">x${fmtNumber(item.quantity ?? 1)}</span>
          </div>
        </div>
      </div>

      <div class="skin-card-copy">${escapeHtml(item.assetDescription?.type || item.type || "Steam item")}</div>

      <div class="skin-card-values">
        <strong>${fmtMoney(getResolvedSteamPrice(item))}</strong>
        <span>${item.sellListings != null ? `${fmtNumber(item.sellListings)} listings` : "Listings unknown"}</span>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".skin-card").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedSkinKey = node.dataset.key;
      render();
      const picked = visible.find((item) => item.key === state.selectedSkinKey);
      if (picked) queueSteamItems([picked], true);
    });
  });
}

function renderSkinHero(item) {
  const target = $("skinHero");
  if (!item) {
    target.innerHTML = `<div class="empty-state">No skin selected.</div>`;
    return;
  }

  target.innerHTML = `
    <section class="skin-hero">
      <div class="skin-hero-inner">
        <div class="skin-hero-media">
          ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="" />` : ""}
        </div>

        <div class="skin-hero-copy">
          <div class="eyebrow">${escapeHtml(item.type || item.category || "Skin")}</div>
          <h2>${escapeHtml(item.name)}</h2>

          <div class="hero-badges">
            <span class="metric-pill ${item.marketable !== false ? "good" : "warn"}">${item.marketable !== false ? "Marketable" : "Non-marketable"}</span>
            <span class="metric-pill ${item.tradable !== false ? "good" : "warn"}">${item.tradable !== false ? "Tradable" : "Trade locked"}</span>
            <span class="metric-pill">x${fmtNumber(item.quantity ?? 1)}</span>
            ${item.sellListings != null ? `<span class="metric-pill">${fmtNumber(item.sellListings)} listings</span>` : ""}
          </div>

          <p>
            This skin card is fully fed by the Steam skin scraper output, including image, Steam price, listings and market URL.
          </p>
        </div>

        <div class="hero-side-actions">
          ${item.listingUrl ? `<a class="btn btn-primary" href="${escapeHtml(item.listingUrl)}" target="_blank" rel="noopener">Steam listing</a>` : ""}
        </div>
      </div>
    </section>

    <section class="metrics-grid">
      ${metricCard("Steam price", fmtMoney(getResolvedSteamPrice(item)), "Taken directly from the skin scraper output")}
      ${metricCard("Listings", item.sellListings != null ? fmtNumber(item.sellListings) : "—", "Steam sell listing count")}
      ${metricCard("Quantity", fmtNumber(item.quantity ?? 1), "Grouped quantity in dataset")}
      ${metricCard("30d trend", fmtPct(getResolvedTrend(item)), "Shown when live Steam market data exists")}
    </section>
  `;
}

function renderSources(payload) {
  $("sourcesList").innerHTML = Object.values(payload.dashboard.sources || {}).map((source) => `
    <article class="source-card">
      <strong>${escapeHtml(source.label || "Source")}</strong>
      <span>${escapeHtml(source.path || "—")}</span>
      <span>${source.timestamp ? `${fmtRelative(source.timestamp)} · ${fmtDate(source.timestamp)}` : "No timestamp"}</span>
      ${source.matched != null ? `<span>${fmtNumber(source.matched)} matched</span>` : ""}
    </article>
  `).join("");
}

function renderLogs(payload) {
  const logs = [...(payload.status.logs || [])].slice(-12).reverse();
  $("logList").innerHTML = logs.length
    ? logs.map((log) => `
      <article class="log-line">
        <strong>${escapeHtml(log.message)}</strong>
        <span>${fmtDate(log.time)}</span>
      </article>
    `).join("")
    : `<div class="empty-state">No logs yet.</div>`;
}

function renderPortfolio() {
  const summary = $("portfolioSummary");
  const list = $("portfolioList");
  const input = $("steamProfileInput");
  input.value = state.portfolioQuery || "";

  if (state.portfolioLoading) {
    summary.innerHTML = `
      <strong>Loading public Steam inventory…</strong>
      <span>Reading public CS2 inventory.</span>
    `;
    list.innerHTML = "";
    return;
  }

  if (state.portfolioError) {
    summary.innerHTML = `
      <strong>Inventory could not be loaded</strong>
      <span>${escapeHtml(state.portfolioError)}</span>
    `;
    list.innerHTML = "";
    return;
  }

  if (!state.portfolio) {
    summary.innerHTML = `
      <strong>No profile loaded</strong>
      <span>Paste a public Steam profile URL, vanity URL, or SteamID64.</span>
    `;
    list.innerHTML = "";
    return;
  }

  const profile = state.portfolio.profile || {};
  summary.innerHTML = `
    <strong>${fmtMoney(state.portfolio.totals?.estimatedValueEur)} estimated value</strong>
    <span>${fmtNumber(state.portfolio.totals?.uniqueItems)} unique items · ${fmtNumber(state.portfolio.totals?.totalQuantity)} total units</span>
    <span>${escapeHtml(profile.personaName || profile.steamId || "Steam profile")} · ${state.portfolio.cached ? "cached" : "fresh"} · ${fmtRelative(state.portfolio.fetchedAt)}</span>
    ${profile.profileUrl ? `<a href="${escapeHtml(profile.profileUrl)}" target="_blank" rel="noopener">Open Steam profile</a>` : ""}
  `;

  const items = (state.portfolio.items || []).slice(0, 14);
  list.innerHTML = items.length
    ? items.map((item) => `
      <article class="portfolio-item">
        ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="" />` : `<div></div>`}
        <div>
          <p class="portfolio-name">${escapeHtml(item.name)}</p>
          <div class="portfolio-meta">
            <span class="category-pill">${escapeHtml(item.type || "Steam item")}</span>
            <span class="metric-pill">x${fmtNumber(item.quantity)}</span>
          </div>
        </div>
        <div class="portfolio-values">
          <strong>${fmtMoney(item.totalPriceEur)}</strong>
          <span>${fmtMoney(item.unitPriceEur)} each</span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">No marketable CS2 items found in this inventory.</div>`;
}

function syncConfigForm(config) {
  $("cfgSchedulerEnabled").checked = !!config.scheduler?.enabled;
  $("cfgIntervalMinutes").value = config.scheduler?.intervalMinutes ?? 360;
  $("cfgRunOnStartup").checked = !!config.scheduler?.runOnStartup;
  $("cfgHeadless").checked = !!config.refresh?.headless;
  $("cfgPriceLimit").value = config.refresh?.priceLimit ?? 50;
  $("cfgTimeseries").checked = !!config.refresh?.includeTimeseries;
  $("cfgStrictness").value = config.analysis?.strictness ?? 55;
  $("cfgStrictnessValue").textContent = config.analysis?.strictness ?? 55;
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

function setActiveTab(tab) {
  state.activeTab = tab;

  $("tabCases").classList.toggle("is-active", tab === "cases");
  $("tabSkins").classList.toggle("is-active", tab === "skins");

  $("caseSidebarBlock").classList.toggle("hidden", tab !== "cases");
  $("skinSidebarBlock").classList.toggle("hidden", tab !== "skins");

  $("caseContent").classList.toggle("hidden", tab !== "cases");
  $("skinsContent").classList.toggle("hidden", tab !== "skins");

  $("explorerTitle").textContent = tab === "cases" ? "Case market" : "Skin universe";
  $("explorerCopy").textContent = tab === "cases"
    ? "Browse Steam-first case opportunities with supply and conviction context."
    : "Browse an image-first skin grid fully fed by the Steam skin scraper output.";

  render();
}

function render() {
  if (!state.payload) {
    renderPortfolio();
    return;
  }

  renderStatus(state.payload);
  renderHero(state.payload);
  syncConfigForm(state.payload.config || {});
  renderSources(state.payload);
  renderLogs(state.payload);
  renderPortfolio();

  if (state.activeTab === "skins") {
    renderSkins();
  } else {
    renderCaseList(applyCaseFilters(getCaseItems()));
  }
}

async function loadDashboard(silent = false) {
  try {
    state.payload = await api("/api/dashboard");
    render();
  } catch (error) {
    if (!silent) showToast(error.message, true);
  }
}

async function loadPortfolio(forceRefresh = false) {
  const query = $("steamProfileInput").value.trim();
  if (!query || state.portfolioLoading) return;

  state.portfolioLoading = true;
  state.portfolioError = null;
  state.portfolioQuery = query;
  renderPortfolio();

  try {
    const payload = await api("/api/steam/public-inventory", {
      method: "POST",
      body: JSON.stringify({
        query,
        refresh: forceRefresh,
      }),
    });
    state.portfolio = payload;
    state.portfolioError = null;
  } catch (error) {
    state.portfolio = null;
    state.portfolioError = error.message;
    showToast(error.message, true);
  } finally {
    state.portfolioLoading = false;
    renderPortfolio();
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
    showToast("Settings saved.");
    loadDashboard(true);
  } catch (error) {
    showToast(error.message, true);
  }
}

function wireSkinFilterMirrors() {
  $("skinSearchInput").addEventListener("input", () => {
    syncSkinFiltersFromSidebar();
    render();
  });
  $("skinTypeFilter").addEventListener("change", () => {
    syncSkinFiltersFromSidebar();
    render();
  });
  $("skinMarketableFilter").addEventListener("change", () => {
    syncSkinFiltersFromSidebar();
    render();
  });
  $("skinSortSelect").addEventListener("change", () => {
    syncSkinFiltersFromSidebar();
    render();
  });

  $("skinSearchInputWide").addEventListener("input", () => {
    syncSkinFiltersFromContent();
    render();
  });
  $("skinTypeFilterWide").addEventListener("change", () => {
    syncSkinFiltersFromContent();
    render();
  });
  $("skinMarketableFilterWide").addEventListener("change", () => {
    syncSkinFiltersFromContent();
    render();
  });
  $("skinSortSelectWide").addEventListener("change", () => {
    syncSkinFiltersFromContent();
    render();
  });
  $("skinTradableFilterWide").addEventListener("change", render);
}

function wire() {
  $("heroInventoryButton").addEventListener("click", () => {
    document.getElementById("steamProfileInput").scrollIntoView({ behavior: "smooth", block: "center" });
    $("steamProfileInput").focus();
  });

  $("heroExploreButton").addEventListener("click", () => {
    document.querySelector(".tabs-surface").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("tabCases").addEventListener("click", () => setActiveTab("cases"));
  $("tabSkins").addEventListener("click", () => setActiveTab("skins"));

  $("searchInput").addEventListener("input", render);
  $("categoryFilter").addEventListener("change", render);
  $("gradeFilter").addEventListener("change", render);
  $("sortSelect").addEventListener("change", render);

  $("refreshButton").addEventListener("click", refreshNow);
  $("saveConfigButton").addEventListener("click", saveConfig);

  $("steamLookupButton").addEventListener("click", () => loadPortfolio(false));
  $("steamRefreshButton").addEventListener("click", () => loadPortfolio(true));
  $("openInventoryPageButton").addEventListener("click", () => {
    const query = $("steamProfileInput").value.trim() || state.portfolioQuery || "";
    if (!query) {
      showToast("Enter a Steam profile first.", true);
      return;
    }
    window.location.href = `/inventory.html?profile=${encodeURIComponent(query)}`;
  });

  $("steamProfileInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadPortfolio(false);
    }
  });

  $("cfgStrictness").addEventListener("input", (event) => {
    $("cfgStrictnessValue").textContent = event.target.value;
  });

  wireSkinFilterMirrors();
}

wire();
startSteamQueue();
loadDashboard();
setInterval(() => loadDashboard(true), 10000);