const state = {
  payload: null,
  portfolio: null,
  portfolioLoading: false,
  portfolioError: null,
  portfolioQuery: "",
  selectedKey: null,
  selectedSkinKey: null,
  activeTab: "containers",
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
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString(undefined, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
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
  toast.style.borderColor = isError
    ? "rgba(255, 117, 102, 0.36)"
    : "rgba(88, 184, 255, 0.36)";
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
  const points = (Array.isArray(values) ? values : []).filter(
    (value) => value != null && Number.isFinite(value)
  );
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

function compareCard(label, value, note) {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p class="muted">${escapeHtml(note)}</p>
    </article>
  `;
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

function getResolvedSteamTrend(item) {
  const live = state.liveMarket.get(item.key);
  return live?.summary?.change30dPct
    ?? item.metrics?.steamChange30dPct
    ?? item.change30dPct
    ?? null;
}

function queueSteamItems(items, prioritize = false) {
  const next = items.filter((item) =>
    item
    && item.key
    && !state.liveMarket.has(item.key)
    && !state.liveFillQueue.has(item.key)
    && getResolvedSteamPrice(item) == null
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
    if (!item || !item.name || state.liveMarket.has(item.key) || state.liveFillQueue.has(item.key)) return;

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

function getInvestmentThesis(item) {
  const points = [];
  if (item.metrics?.steamDiscountPct != null && item.metrics.steamDiscountPct >= 20) {
    points.push("SkinBaron is meaningfully below Steam");
  }
  if (item.isCase && item.metrics?.burnRatio != null && item.metrics.burnRatio >= 0.7) {
    points.push("burn ratio is strong");
  }
  if (item.isCase && item.metrics?.momentum12m != null && item.metrics.momentum12m < 0) {
    points.push("supply is still shrinking");
  }
  if (item.price?.steamVolume != null && item.price.steamVolume >= 500) {
    points.push("Steam liquidity is usable");
  }
  if (item.metrics?.extinctionMonths != null && item.metrics.extinctionMonths <= 72) {
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
    compareCard("SkinBaron floor", fmtMoney(item.price?.skinbaronFloorEur), "Cheapest external entry in the current scrape."),
    compareCard("Entry gap", fmtPct(item.metrics?.steamDiscountPct), "Positive means the outside market is cheaper than Steam."),
    compareCard("Steam 30d", fmtPct(getResolvedSteamTrend(item)), "Recent price direction on Steam."),
    compareCard("Liquidity", item.price?.steamVolume != null ? `${fmtNumber(item.price.steamVolume)} volume` : "—", "Higher volume means easier exits."),
  ];

  if (item.isCase) {
    cards.push(
      compareCard("Burn ratio", item.metrics?.burnRatio != null ? item.metrics.burnRatio.toFixed(2) : "—", "Higher burn supports the scarcity case."),
      compareCard("12m supply", fmtPct(item.metrics?.momentum12m), "Negative means supply kept shrinking."),
      compareCard("Remaining supply", item.metrics?.remaining != null ? fmtNumber(item.metrics.remaining) : "—", "Current remaining tracked supply."),
      compareCard("Extinction", item.metrics?.extinctionMonths != null ? `${item.metrics.extinctionMonths.toFixed(1)} mo` : "—", "How long the scarcity path could take at the current pace.")
    );
  } else {
    cards.push(
      compareCard("Confidence", `${fmtScore(item.scores?.confidence)}%`, "How complete the read is across sources."),
      compareCard("Category", item.category?.label || item.category || "Item", "Container type used for grouping."),
      compareCard("Score", `${fmtScore(item.scores?.total)} / 100`, "Overall investment read."),
      compareCard("Risk", `${fmtScore(item.scores?.risk)} / 100`, "Lower is better.")
    );
  }

  return cards.join("");
}

function getContainerItems() {
  return Array.isArray(state.payload?.dashboard?.items) ? state.payload.dashboard.items : [];
}

function normalizeSkinType(item) {
  const raw = String(
    item.type ||
    item.category ||
    item.weaponType ||
    item.assetDescription?.type ||
    ""
  ).trim();
  if (raw) return raw;

  const name = String(item.name || "").toLowerCase();
  if (name.includes("knife")) return "Knife";
  if (name.includes("gloves")) return "Gloves";
  if (name.includes("ak-47") || name.includes("m4a1") || name.includes("m4a4") || name.includes("famas") || name.includes("galil") || name.includes("aug") || name.includes("sg 553")) return "Rifle";
  if (name.includes("awp") || name.includes("ssg 08") || name.includes("scar-20") || name.includes("g3sg1")) return "Sniper";
  if (name.includes("glock-18") || name.includes("usp-s") || name.includes("desert eagle") || name.includes("p250") || name.includes("tec-9")) return "Pistol";
  if (name.includes("mp9") || name.includes("mp7") || name.includes("mac-10") || name.includes("ump-45") || name.includes("p90") || name.includes("pp-bizon")) return "SMG";
  return "Other";
}

function getSkinItems() {
  const explicit = state.payload?.dashboard?.skins;
  if (Array.isArray(explicit)) {
    return explicit.map((item, index) => ({
      ...item,
      key: item.key || item.hashName || item.marketHashName || item.name || `skin-${index}`,
      type: normalizeSkinType(item),
      iconUrl: item.iconUrl || item.image || item.icon || null,
      listingUrl: item.listingUrl || item.marketUrl || null,
      marketable: item.marketable !== false,
      tradable: item.tradable !== false,
      quantity: item.quantity ?? 1,
      steamPriceEur: item.steamPriceEur ?? item.unitPriceEur ?? null,
      totalPriceEur: item.totalPriceEur ?? ((item.unitPriceEur ?? item.steamPriceEur ?? null) != null ? (item.unitPriceEur ?? item.steamPriceEur) * (item.quantity ?? 1) : null),
      change30dPct: item.change30dPct ?? item.metrics?.steamChange30dPct ?? null,
      sellListings: item.sellListings ?? item.listings ?? null,
    }));
  }
  return [];
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
  const containers = getContainerItems();
  const skins = getSkinItems();
  const overview = payload.dashboard.overview || {};

  $("heroUniverse").textContent = fmtNumber(containers.length + skins.length);
  $("heroUniverseMeta").textContent = `${fmtNumber(containers.length)} containers · ${fmtNumber(skins.length)} skins`;
  $("heroTopName").textContent = overview.topCandidate?.name || (containers[0]?.name || "—");
  $("heroTopMeta").textContent = overview.topCandidate
    ? `${overview.topCandidate.category} · score ${fmtScore(overview.topCandidate.score)} · risk ${fmtScore(1 - overview.topCandidate.risk)}`
    : skins.length
      ? `Skins dataset loaded · ${fmtNumber(skins.length)} tracked`
      : "No ranking yet";
  $("heroDiscount").textContent = overview.bestDiscount?.name || "—";
  $("heroDiscountMeta").textContent = overview.bestDiscount?.change30dPct != null
    ? `30d trend ${fmtPct(overview.bestDiscount.change30dPct)}`
    : "Need Steam coverage";
  $("heroTrend").textContent = overview.strongestSteamTrend?.name || "—";
  $("heroTrendMeta").textContent = overview.strongestSteamTrend?.change30dPct != null
    ? fmtPct(overview.strongestSteamTrend.change30dPct)
    : skins.length
      ? "Skins ready for grid view"
      : "Need trend data";
}

function applyContainerView(items) {
  const query = $("searchInput").value.trim().toLowerCase();
  const category = $("categoryFilter").value;
  const grade = $("gradeFilter").value;
  const sort = $("sortSelect").value;

  let filtered = [...items];
  if (query) filtered = filtered.filter((item) => item.name.toLowerCase().includes(query));
  if (category !== "ALL") filtered = filtered.filter((item) => item.category?.key === category);
  if (grade !== "ALL") filtered = filtered.filter((item) => item.grade?.label === grade);

  const sorters = {
    score: (item) => item.scores?.total ?? -1,
    discount: (item) => item.metrics?.steamDiscountPct ?? -999,
    trend: (item) => item.metrics?.steamChange30dPct ?? -999,
    liquidity: (item) => item.price?.steamVolume ?? -1,
    scarcity: (item) => item.scores?.scarcity ?? -1,
  };

  filtered.sort((left, right) => (sorters[sort]?.(right) ?? 0) - (sorters[sort]?.(left) ?? 0));
  return filtered;
}

function syncSkinFilterMirrors() {
  $("skinSearchInputWide").value = $("skinSearchInput").value;
  $("skinTypeFilterWide").value = $("skinTypeFilter").value;
  $("skinMarketableFilterWide").value = $("skinMarketableFilter").value;
  $("skinSortSelectWide").value = $("skinSortSelect").value;
}

function syncSkinFilterMirrorsReverse() {
  $("skinSearchInput").value = $("skinSearchInputWide").value;
  $("skinTypeFilter").value = $("skinTypeFilterWide").value;
  $("skinMarketableFilter").value = $("skinMarketableFilterWide").value;
  $("skinSortSelect").value = $("skinSortSelectWide").value;
}

function populateSkinTypeFilters(items) {
  const types = [...new Set(items.map((item) => normalizeSkinType(item)).filter(Boolean))].sort();
  const html = ['<option value="ALL">All</option>', ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)].join("");

  const currentA = $("skinTypeFilter").value || "ALL";
  const currentB = $("skinTypeFilterWide").value || "ALL";

  $("skinTypeFilter").innerHTML = html;
  $("skinTypeFilterWide").innerHTML = html;

  $("skinTypeFilter").value = types.includes(currentA) ? currentA : "ALL";
  $("skinTypeFilterWide").value = types.includes(currentB) ? currentB : $("skinTypeFilter").value;
}

function applySkinView(items) {
  const search = $("skinSearchInput").value.trim().toLowerCase();
  const typeFilter = $("skinTypeFilter").value;
  const marketableFilter = $("skinMarketableFilter").value;
  const tradableFilter = $("skinTradableFilterWide").value;
  const sort = $("skinSortSelect").value;

  let filtered = items.map((item) => ({
    ...item,
    type: normalizeSkinType(item),
  }));

  if (search) {
    filtered = filtered.filter((item) => String(item.name || "").toLowerCase().includes(search));
  }

  if (typeFilter !== "ALL") {
    filtered = filtered.filter((item) => item.type === typeFilter);
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

function renderContainerList(items) {
  const list = $("caseList");
  if (!items.length) {
    list.innerHTML = `<div class="item-row"><p class="muted">No items match the current filters.</p></div>`;
    return;
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
            <span class="category-pill">${escapeHtml(item.category?.label || item.category || "Item")}</span>
            <span class="grade-pill ${toneClass(item.grade?.label || "WARN")}">${escapeHtml(item.grade?.label || "WARN")}</span>
          </div>
        </div>
        <div class="metric-pill ${toneClass(item.grade?.label || "WARN")}">${fmtScore(item.scores?.total)}</div>
      </div>
      <div class="score-row">
        <div class="score-cell">
          <span>Steam</span>
          <strong>${fmtMoney(getResolvedSteamPrice(item))}</strong>
        </div>
        <div class="score-cell">
          <span>SkinBaron</span>
          <strong>${fmtMoney(item.price?.skinbaronFloorEur)}</strong>
        </div>
        <div class="score-cell">
          <span>30d</span>
          <strong>${fmtPct(getResolvedSteamTrend(item))}</strong>
        </div>
      </div>
      <p class="muted">${escapeHtml(item.grade?.reason || "Mixed setup")}</p>
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
}

function renderSkinStats(allSkins, visibleSkins) {
  $("skinsVisibleCount").textContent = fmtNumber(visibleSkins.length);
  $("skinsTotalCount").textContent = fmtNumber(allSkins.length);
  $("skinsMarketableCount").textContent = fmtNumber(allSkins.filter((item) => item.marketable !== false).length);

  const priced = visibleSkins.map((item) => getResolvedSteamPrice(item)).filter((value) => value != null && Number.isFinite(value));
  const avg = priced.length ? priced.reduce((sum, value) => sum + value, 0) / priced.length : null;
  $("skinsAvgPrice").textContent = fmtMoney(avg);
}

function renderSkinHero(item) {
  const target = $("skinHeroCard");
  if (!item) {
    target.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <p>No skin selected.</p>
      </div>
    `;
    return;
  }

  const live = state.liveMarket.get(item.key);
  const price = getResolvedSteamPrice(item);
  const trend = getResolvedSteamTrend(item);

  target.innerHTML = `
    ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="" />` : `<div class="score-cell"></div>`}
    <div>
      <p class="eyebrow">${escapeHtml(item.type || "Skin")}</p>
      <h2 class="skin-hero-title">${escapeHtml(item.name)}</h2>
      <div class="skin-hero-tags">
        <span class="category-pill">${escapeHtml(item.type || "Other")}</span>
        <span class="metric-pill ${item.marketable !== false ? "good" : "warn"}">${item.marketable !== false ? "Marketable" : "Non-marketable"}</span>
        <span class="metric-pill ${item.tradable !== false ? "good" : "warn"}">${item.tradable !== false ? "Tradable" : "Trade locked"}</span>
        <span class="metric-pill">x${fmtNumber(item.quantity ?? 1)}</span>
        ${item.sellListings != null ? `<span class="metric-pill">${fmtNumber(item.sellListings)} listings</span>` : ""}
      </div>
      <div class="score-grid" style="margin-top:14px;">
        ${compareCard("Steam price", fmtMoney(price), "Resolved from Steam cache or live market")}
        ${compareCard("30d trend", fmtPct(trend), "Recent Steam price direction")}
        ${compareCard("Quantity", fmtNumber(item.quantity ?? 1), "Grouped units in the current dataset")}
        ${compareCard("Listings", item.sellListings != null ? fmtNumber(item.sellListings) : "—", "Sell listing count from scrape or market")}
      </div>
    </div>
    <div class="skin-hero-actions">
      ${item.listingUrl ? `<a class="button" href="${escapeHtml(item.listingUrl)}" target="_blank" rel="noopener">Steam listing</a>` : ""}
      ${item.name ? `<button class="button" id="skinLiveRefreshButton" type="button">Refresh live</button>` : ""}
      ${live?.orderbook ? `<span class="metric-pill good">Orderbook ready</span>` : `<span class="metric-pill warn">Orderbook pending</span>`}
    </div>
  `;

  const refreshButton = $("skinLiveRefreshButton");
  if (refreshButton) {
    refreshButton.addEventListener("click", async () => {
      if (!item.name) return;
      state.loadingMarketKey = item.key;
      render();
      try {
        const payload = await api(`/api/item-market?name=${encodeURIComponent(item.name)}`);
        state.liveMarket.set(item.key, payload.market);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        state.loadingMarketKey = null;
        render();
      }
    });
  }
}

function renderSkinsGrid(items) {
  const grid = $("skinsGrid");

  if (!items.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;">No skins match the current filters.</div>`;
    renderSkinHero(null);
    return;
  }

  if (!items.some((item) => item.key === state.selectedSkinKey)) {
    state.selectedSkinKey = items[0].key;
  }

  const selected = items.find((item) => item.key === state.selectedSkinKey) || items[0];
  renderSkinHero(selected);

  grid.innerHTML = items.map((item) => `
    <article class="skin-card${item.key === state.selectedSkinKey ? " active" : ""}" data-key="${escapeHtml(item.key)}">
      <div class="skin-card-top">
        ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="" loading="lazy" />` : `<div class="score-cell"></div>`}
        <div>
          <h3>${escapeHtml(item.name)}</h3>
          <div class="skin-card-tags">
            <span class="category-pill">${escapeHtml(item.type || "Other")}</span>
            <span class="metric-pill ${item.marketable !== false ? "good" : "warn"}">${item.marketable !== false ? "Marketable" : "No market"}</span>
            <span class="metric-pill">x${fmtNumber(item.quantity ?? 1)}</span>
          </div>
        </div>
      </div>
      <div class="muted">${escapeHtml(item.assetDescription?.type || item.rawType || item.type || "Steam item")}</div>
      <div class="skin-card-values">
        <strong>${fmtMoney(getResolvedSteamPrice(item))}</strong>
        <span class="muted">30d ${fmtPct(getResolvedSteamTrend(item))}</span>
        <span class="muted">${item.sellListings != null ? `${fmtNumber(item.sellListings)} listings` : "Listings unknown"}</span>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".skin-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedSkinKey = card.dataset.key;
      render();
      const chosen = items.find((item) => item.key === state.selectedSkinKey);
      if (chosen) queueSteamItems([chosen], true);
    });
  });

  queueSteamItems(items.slice(0, 24), false);
}

async function ensureLiveMarket() {
  const item = getContainerItems().find((entry) => entry.key === state.selectedKey);
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

function hydrateVisibleSteam(items) {
  queueSteamItems(items, false);
}

function refreshVisibleSteam(items) {
  queueSteamItems(items, false);
}

function scheduleLiveSteamRefresh() {
  if (state.liveRefreshTimer) {
    clearInterval(state.liveRefreshTimer);
  }

  state.liveRefreshTimer = setInterval(() => {
    if (state.activeTab === "containers") {
      const containers = getContainerItems();
      if (!containers.length) return;
      const filtered = state.lastRenderedKeys.length
        ? containers.filter((item) => state.lastRenderedKeys.includes(item.key))
        : applyContainerView(containers);
      if (!filtered.length) return;

      const batchSize = 8;
      const start = state.liveRefreshCursor % filtered.length;
      const rotating = [];
      for (let index = 0; index < Math.min(batchSize, filtered.length); index += 1) {
        rotating.push(filtered[(start + index) % filtered.length]);
      }
      state.liveRefreshCursor = (start + batchSize) % filtered.length;

      const selected = containers.find((item) => item.key === state.selectedKey);
      const targets = selected
        ? [selected, ...rotating.filter((item) => item.key !== selected.key)]
        : rotating;
      refreshVisibleSteam(targets);
      return;
    }

    const skins = applySkinView(getSkinItems());
    if (!skins.length) return;
    refreshVisibleSteam(skins.slice(0, 12));
  }, 10000);
}

function renderSources(payload) {
  $("sourcesList").innerHTML = Object.values(payload.dashboard.sources || {}).map((source) => `
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
  const summary = $("portfolioSummary");
  const list = $("portfolioList");
  const lookupButton = $("steamLookupButton");
  const refreshButton = $("steamRefreshButton");
  const openInventoryPageButton = $("openInventoryPageButton");
  const input = $("steamProfileInput");

  input.value = state.portfolioQuery || "";

  lookupButton.disabled = state.portfolioLoading;
  refreshButton.disabled = state.portfolioLoading || !state.portfolioQuery;
  openInventoryPageButton.disabled = !input.value.trim() && !state.portfolioQuery;

  if (state.portfolioLoading) {
    summary.innerHTML = `
      <strong>Loading public Steam inventory...</strong>
      <span class="muted">Reading public CS2 inventory.</span>
    `;
    list.innerHTML = "";
    return;
  }

  if (state.portfolioError) {
    summary.innerHTML = `
      <strong>Inventory could not be loaded</strong>
      <span class="muted">${escapeHtml(state.portfolioError)}</span>
      <span class="muted">The Steam profile must exist and the inventory must be public.</span>
    `;
    list.innerHTML = "";
    return;
  }

  if (!state.portfolio) {
    summary.innerHTML = `
      <strong>No profile loaded</strong>
      <span class="muted">Paste a public Steam profile URL, vanity URL, or SteamID64.</span>
    `;
    list.innerHTML = "";
    return;
  }

  const profile = state.portfolio.profile || {};
  summary.innerHTML = `
    <strong>${fmtMoney(state.portfolio.totals?.estimatedValueEur)} estimated value</strong>
    <span class="muted">${fmtNumber(state.portfolio.totals?.uniqueItems)} unique items · ${fmtNumber(state.portfolio.totals?.totalQuantity)} total units</span>
    <span class="muted">${fmtNumber(state.portfolio.totals?.matchedItems)} matched to the dashboard pricing layer</span>
    <span class="muted">${escapeHtml(profile.personaName || profile.steamId || "Steam profile")} · ${state.portfolio.cached ? "cached" : "fresh"} · ${fmtRelative(state.portfolio.fetchedAt)}</span>
    ${profile.profileUrl ? `<span class="muted"><a href="${escapeHtml(profile.profileUrl)}" target="_blank" rel="noopener">Open Steam profile</a></span>` : ""}
  `;

  const items = (state.portfolio.items || []).slice(0, 16);
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
  const item = getContainerItems().find((entry) => entry.key === state.selectedKey) || visibleItems[0];
  if (!item) {
    $("focusContent").className = "empty-state";
    $("focusContent").innerHTML = "<p>No item selected.</p>";
    return;
  }

  const live = state.liveMarket.get(item.key);
  const loading = state.loadingMarketKey === item.key;
  const sellRows = live?.orderbook?.sellLevels?.slice(0, 5) || [];

  $("focusContent").className = "detail-shell";
  $("focusContent").innerHTML = `
    <section class="focus-band">
      <div class="detail-top">
        <div class="detail-title">
          <p class="eyebrow">${escapeHtml(item.category?.label || item.category || "Item")}</p>
          <h2>${escapeHtml(item.name)}</h2>
          <div class="detail-headline">
            <span class="grade-pill ${toneClass(item.grade?.label || "WARN")}">${escapeHtml(item.grade?.label || "WARN")}</span>
            <span class="metric-pill ${toneClass(item.grade?.label || "WARN")}">Score ${fmtScore(item.scores?.total)}</span>
            <span class="metric-pill warn">Entry ${fmtScore(item.scores?.entry)}</span>
            <span class="metric-pill ${(item.scores?.risk ?? 0.5) <= 0.35 ? "good" : (item.scores?.risk ?? 0.5) >= 0.65 ? "bad" : "warn"}">Risk ${fmtScore(item.scores?.risk)}</span>
            <span class="metric-pill ${(item.scores?.confidence ?? 0) >= 0.75 ? "good" : "warn"}">Confidence ${fmtScore(item.scores?.confidence)}</span>
          </div>
          <p class="detail-summary">${escapeHtml(getInvestmentThesis(item))}</p>
        </div>
        <div class="detail-actions">
          ${item.urls?.csstonks ? `<a class="button" href="${escapeHtml(item.urls.csstonks)}" target="_blank" rel="noopener">CSStonks</a>` : ""}
          ${item.urls?.steam ? `<a class="button" href="${escapeHtml(item.urls.steam)}" target="_blank" rel="noopener">Steam</a>` : ""}
          ${item.urls?.skinbaron ? `<a class="button" href="${escapeHtml(item.urls.skinbaron)}" target="_blank" rel="noopener">SkinBaron</a>` : ""}
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
        <div class="chart-shell">${chartSvg(live?.history?.map((point) => point.price) || item.charts?.steam, "#58b8ff")}</div>
        <div class="chart-meta">
          <span class="muted">Sale starting at ${fmtMoney(live?.overview?.lowestPriceEur ?? item.price?.steamPriceEur)}</span>
          <span class="muted">7d ${fmtPct(live?.summary?.change7dPct ?? item.metrics?.steamChange7dPct)}</span>
          <span class="muted">30d ${fmtPct(live?.summary?.change30dPct ?? item.metrics?.steamChange30dPct)}</span>
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
        <div class="chart-shell">${chartSvg(item.charts?.activity, "#59d484")}</div>
        <div class="chart-meta">
          <span class="muted">Burn ratio ${item.metrics?.burnRatio != null ? item.metrics.burnRatio.toFixed(2) : "—"}</span>
          <span class="muted">12m supply ${fmtPct(item.metrics?.momentum12m)}</span>
          <span class="muted">Extinction ${item.metrics?.extinctionMonths != null ? `${item.metrics.extinctionMonths.toFixed(1)} mo` : "—"}</span>
        </div>
      </article>

      <article class="chart-card">
        <span>Decision notes</span>
        <h3>What matters for the entry</h3>
        <div class="market-list">
          ${(item.thesis || []).map((line) => `<div class="market-row"><span>${escapeHtml(line)}</span></div>`).join("")}
        </div>
        <h3 style="margin-top:14px;">What can break it</h3>
        <div class="market-list">
          ${(item.risks || []).map((line) => `<div class="market-row"><span>${escapeHtml(line)}</span></div>`).join("")}
        </div>
      </article>
    </section>
  `;
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
  $("tabContainers").classList.toggle("active", tab === "containers");
  $("tabSkins").classList.toggle("active", tab === "skins");

  $("containerFilters").classList.toggle("hidden", tab !== "containers");
  $("caseList").classList.toggle("hidden", tab !== "containers");
  $("skinsSidebarInfo").classList.toggle("hidden", tab !== "skins");

  $("focusContent").classList.toggle("hidden", tab !== "containers");
  $("skinsWorkspace").classList.toggle("active", tab === "skins");

  $("explorerTitle").textContent = tab === "containers" ? "All containers" : "Skin universe";
  $("explorerSubcopy").textContent = tab === "containers"
    ? "The classic list stays perfect for cases, capsules, souvenirs and similar containers."
    : "Skins move into a grid because large skin datasets do not belong in a narrow left-hand list.";

  render();
}

function renderContainers() {
  const items = applyContainerView(getContainerItems());
  renderContainerList(items);
  renderFocus(state.payload, items);
}

function renderSkins() {
  const allSkins = getSkinItems();
  populateSkinTypeFilters(allSkins);
  const visible = applySkinView(allSkins);
  renderSkinStats(allSkins, visible);
  renderSkinsGrid(visible);
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
    renderContainers();
  }
}

async function loadDashboard(silent = false) {
  try {
    state.payload = await api("/api/dashboard");
    render();
    if (state.activeTab === "containers") {
      ensureLiveMarket();
    }
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
    showToast("Automation saved.");
    loadDashboard(true);
  } catch (error) {
    showToast(error.message, true);
  }
}

function wireSkinMirrorInputs() {
  $("skinSearchInput").addEventListener("input", () => {
    syncSkinFilterMirrors();
    render();
  });
  $("skinTypeFilter").addEventListener("change", () => {
    syncSkinFilterMirrors();
    render();
  });
  $("skinMarketableFilter").addEventListener("change", () => {
    syncSkinFilterMirrors();
    render();
  });
  $("skinSortSelect").addEventListener("change", () => {
    syncSkinFilterMirrors();
    render();
  });

  $("skinSearchInputWide").addEventListener("input", () => {
    syncSkinFilterMirrorsReverse();
    render();
  });
  $("skinTypeFilterWide").addEventListener("change", () => {
    syncSkinFilterMirrorsReverse();
    render();
  });
  $("skinMarketableFilterWide").addEventListener("change", () => {
    syncSkinFilterMirrorsReverse();
    render();
  });
  $("skinSortSelectWide").addEventListener("change", () => {
    syncSkinFilterMirrorsReverse();
    render();
  });
  $("skinTradableFilterWide").addEventListener("change", render);
}

function wire() {
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

  $("searchInput").addEventListener("input", render);
  $("categoryFilter").addEventListener("change", render);
  $("gradeFilter").addEventListener("change", render);
  $("sortSelect").addEventListener("change", render);

  $("tabContainers").addEventListener("click", () => setActiveTab("containers"));
  $("tabSkins").addEventListener("click", () => setActiveTab("skins"));

  wireSkinMirrorInputs();
}

wire();
startSteamQueue();
loadDashboard();
scheduleLiveSteamRefresh();
setInterval(() => loadDashboard(true), 10000);