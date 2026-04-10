const state = {
  payload: null,
  portfolio: null,
  portfolioLoading: false,
  portfolioError: null,
  portfolioQuery: "",
  selectedCaseKey: null,
  selectedSkinKey: null,
  activeTab: "cases",
  chartRange: "7d",
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

function fmtShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date);
}

function fmtSteamTooltipDate(value) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

function getCaseItems() {
  return Array.isArray(state.payload?.dashboard?.items) ? state.payload.dashboard.items : [];
}

function getSkinItems() {
  return Array.isArray(state.payload?.dashboard?.skins) ? state.payload.dashboard.skins : [];
}

function getResolvedSteamPrice(item) {
  return item?.price?.steamPriceEur
    ?? item?.steamPriceEur
    ?? item?.unitPriceEur
    ?? null;
}

function getResolvedTrend(item) {
  return item?.metrics?.steamChange30dPct
    ?? item?.change30dPct
    ?? null;
}

function getResolvedListings(item) {
  return item?.price?.steamVolume
    ?? item?.sellListings
    ?? null;
}

function renderSimpleSpark(values, color = "#35d07f") {
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
    <svg viewBox="0 0 640 190" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        fill="none"
        stroke="${color}"
        stroke-width="3"
        points="${coords.join(" ")}"
      ></polyline>
    </svg>
  `;
}

function getRawSteamHistory(item) {
  if (Array.isArray(item?.charts?.steamHistory) && item.charts.steamHistory.length) {
    return item.charts.steamHistory;
  }

  if (Array.isArray(item?.steamHistory) && item.steamHistory.length) {
    return item.steamHistory;
  }

  return [];
}

function normalizeHistoryPoint(point, index = 0) {
  if (!point) return null;

  if (typeof point === "number") {
    return {
      date: null,
      ts: index,
      priceEur: Number(point),
      volume: null,
    };
  }

  const priceEur = Number(
    point.priceEur ??
    point.price ??
    point.value ??
    point.close ??
    point.medianPriceEur ??
    point.lowestPriceEur
  );

  if (!Number.isFinite(priceEur)) return null;

  const rawDate = point.date || point.time || point.timestamp || null;
  const parsed = rawDate ? new Date(rawDate) : null;
  const ts = parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : index;

  return {
    date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    ts,
    priceEur,
    volume: Number.isFinite(Number(point.volume)) ? Number(point.volume) : null,
  };
}

function getNormalizedSteamHistory(item) {
  return getRawSteamHistory(item)
    .map((point, index) => normalizeHistoryPoint(point, index))
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);
}

function getRangeConfig(range) {
  switch (range) {
    case "7d":
      return { days: 7, bucketMs: 12 * 60 * 60 * 1000, smoothWindow: 2 };
    case "30d":
      return { days: 30, bucketMs: 24 * 60 * 60 * 1000, smoothWindow: 2 };
    case "180d":
      return { days: 180, bucketMs: 3 * 24 * 60 * 60 * 1000, smoothWindow: 3 };
    case "365d":
      return { days: 365, bucketMs: 7 * 24 * 60 * 60 * 1000, smoothWindow: 3 };
    case "all":
    default:
      return { days: null, bucketMs: 14 * 24 * 60 * 60 * 1000, smoothWindow: 3 };
  }
}

function filterHistoryByRange(points, range) {
  const rows = Array.isArray(points) ? points : [];
  if (!rows.length) return [];

  const config = getRangeConfig(range);
  if (!config.days) return rows;

  const latestTs = rows[rows.length - 1]?.ts;
  if (!Number.isFinite(latestTs)) return rows;

  const cutoff = latestTs - (config.days * 24 * 60 * 60 * 1000);
  const filtered = rows.filter((point) => Number.isFinite(point.ts) && point.ts >= cutoff);

  return filtered.length ? filtered : rows;
}

function bucketizeHistory(points, bucketMs) {
  const rows = Array.isArray(points) ? points : [];
  if (!rows.length) return [];

  const buckets = new Map();

  for (const point of rows) {
    const bucketKey = Math.floor(point.ts / bucketMs) * bucketMs;
    const existing = buckets.get(bucketKey) || {
      ts: bucketKey,
      date: new Date(bucketKey).toISOString(),
      prices: [],
      volumes: [],
    };

    existing.prices.push(point.priceEur);
    if (point.volume != null && Number.isFinite(point.volume)) {
      existing.volumes.push(point.volume);
    }

    buckets.set(bucketKey, existing);
  }

  return [...buckets.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((bucket) => {
      const avgPrice =
        bucket.prices.reduce((sum, value) => sum + value, 0) / Math.max(1, bucket.prices.length);

      const avgVolume = bucket.volumes.length
        ? bucket.volumes.reduce((sum, value) => sum + value, 0) / bucket.volumes.length
        : null;

      return {
        ts: bucket.ts,
        date: bucket.date,
        priceEur: avgPrice,
        volume: avgVolume,
      };
    });
}

function smoothHistory(points, windowSize = 2) {
  const rows = Array.isArray(points) ? points : [];
  if (!rows.length || windowSize <= 1) return rows;

  return rows.map((point, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const slice = rows.slice(start, index + 1);
    const avgPrice = slice.reduce((sum, row) => sum + row.priceEur, 0) / slice.length;

    return {
      ...point,
      priceEur: avgPrice,
    };
  });
}

function prepareChartHistory(item, range) {
  const raw = getNormalizedSteamHistory(item);
  const filtered = filterHistoryByRange(raw, range);

  if (!filtered.length) return [];

  const config = getRangeConfig(range);
  const bucketed = bucketizeHistory(filtered, config.bucketMs);
  const smoothed = smoothHistory(bucketed, config.smoothWindow);

  return smoothed;
}

function getHistorySummary(points) {
  const rows = Array.isArray(points) ? points : [];
  const prices = rows.map((point) => point.priceEur).filter((value) => value != null && Number.isFinite(value));

  if (!prices.length) {
    return {
      min: null,
      max: null,
      first: null,
      last: null,
      changePct: null,
      latestDate: null,
    };
  }

  const first = prices[0];
  const last = prices[prices.length - 1];
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  return {
    min,
    max,
    first,
    last,
    changePct: first && first !== 0 ? ((last - first) / first) * 100 : null,
    latestDate: rows[rows.length - 1]?.date || null,
  };
}

function getChartRangeLabel(range) {
  const labels = {
    "7d": "1 week",
    "30d": "1 maand",
    "180d": "6 maanden",
    "365d": "1 jaar",
    "all": "Alles",
  };
  return labels[range] || "1 week";
}

function renderChartRangeControls(context) {
  const ranges = [
    { key: "7d", label: "1 week" },
    { key: "30d", label: "1 maand" },
    { key: "180d", label: "6 maanden" },
    { key: "365d", label: "1 jaar" },
    { key: "all", label: "Alles" },
  ];

  return `
    <div class="chart-panel-head">
      <div>
        <div class="chart-title-eyebrow">Laatste verkoopprijzen</div>
        <h4 class="chart-panel-title">Steam</h4>
      </div>

      <div class="chart-range-group" data-chart-context="${escapeHtml(context)}">
        ${ranges.map((range) => `
          <button
            class="chart-range-btn ${state.chartRange === range.key ? "is-active" : ""}"
            type="button"
            data-chart-range="${escapeHtml(range.key)}"
            data-chart-context="${escapeHtml(context)}"
          >${escapeHtml(range.label)}</button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderChartMeta(points, fallbackChangePct = null) {
  const summary = getHistorySummary(points);

  return `
    <div class="chart-meta-row">
      <div class="chart-meta-pill">
        <span>Range</span>
        <strong>${escapeHtml(getChartRangeLabel(state.chartRange))}</strong>
      </div>
      <div class="chart-meta-pill">
        <span>Start</span>
        <strong>${summary.first != null ? fmtMoney(summary.first) : "—"}</strong>
      </div>
      <div class="chart-meta-pill">
        <span>Laatste</span>
        <strong>${summary.last != null ? fmtMoney(summary.last) : "—"}</strong>
      </div>
      <div class="chart-meta-pill">
        <span>Verandering</span>
        <strong>${fmtPct(summary.changePct ?? fallbackChangePct)}</strong>
      </div>
      <div class="chart-meta-pill">
        <span>Laatste punt</span>
        <strong>${summary.latestDate ? fmtShortDate(summary.latestDate) : "—"}</strong>
      </div>
    </div>
  `;
}

function renderDatedPriceChart(points, chartId) {
  const rows = Array.isArray(points) ? points : [];
  const prices = rows.map((point) => point.priceEur).filter((value) => value != null && Number.isFinite(value));

  if (!prices.length) {
    return `<div class="empty-state">No chart data available.</div>`;
  }

  const width = 860;
  const height = 280;
  const paddingTop = 20;
  const paddingRight = 18;
  const paddingBottom = 34;
  const paddingLeft = 56;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const minTs = rows[0].ts;
  const maxTs = rows[rows.length - 1].ts;

  const usableWidth = width - paddingLeft - paddingRight;
  const usableHeight = height - paddingTop - paddingBottom;

  const coords = rows.map((point) => {
    const xRatio = (point.ts - minTs) / Math.max(1, maxTs - minTs);
    const x = paddingLeft + (xRatio * usableWidth);
    const y = paddingTop + ((max - point.priceEur) / range) * usableHeight;

    return {
      x,
      y,
      ts: point.ts,
      date: point.date,
      priceEur: point.priceEur,
    };
  });

  const polyline = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");

  const yTicks = 5;
  const yLabels = Array.from({ length: yTicks }, (_, idx) => {
    const ratio = idx / Math.max(1, yTicks - 1);
    const value = max - ((max - min) * ratio);
    const y = paddingTop + (usableHeight * ratio);
    return { value, y };
  });

  const xLabelIndexes = rows.length <= 2
    ? rows.map((_, index) => index)
    : Array.from(new Set([
        0,
        Math.floor((rows.length - 1) * 0.25),
        Math.floor((rows.length - 1) * 0.5),
        Math.floor((rows.length - 1) * 0.75),
        rows.length - 1,
      ]));

  const xLabels = xLabelIndexes.map((index) => {
    const point = rows[index];
    const coord = coords[index];
    return {
      x: coord?.x ?? paddingLeft,
      label: point?.date ? fmtShortDate(point.date) : `${index + 1}`,
    };
  });

  const fillPath = [
    `M ${coords[0].x.toFixed(1)} ${height - paddingBottom}`,
    ...coords.map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
    `L ${coords[coords.length - 1].x.toFixed(1)} ${height - paddingBottom}`,
    "Z",
  ].join(" ");

  const interactionRects = coords.map((point, index) => {
    const prevX = index > 0 ? coords[index - 1].x : paddingLeft;
    const nextX = index < coords.length - 1 ? coords[index + 1].x : width - paddingRight;
    const left = index === 0 ? paddingLeft : (prevX + point.x) / 2;
    const right = index === coords.length - 1 ? width - paddingRight : (point.x + nextX) / 2;
    const rectWidth = Math.max(12, right - left);

    return `
      <rect
        x="${left.toFixed(1)}"
        y="${paddingTop}"
        width="${rectWidth.toFixed(1)}"
        height="${usableHeight}"
        fill="transparent"
        data-chart-point="1"
        data-chart-id="${escapeHtml(chartId)}"
        data-point-index="${index}"
        data-price="${point.priceEur}"
        data-date="${escapeHtml(point.date || "")}"
        data-x="${point.x.toFixed(1)}"
        data-y="${point.y.toFixed(1)}"
        style="cursor: crosshair;"
      ></rect>
    `;
  }).join("");

  return `
    <div
      class="chart-rich"
      data-steam-chart="${escapeHtml(chartId)}"
      style="position:relative;width:100%;height:100%;"
    >
      <div
        data-chart-tooltip="${escapeHtml(chartId)}"
        style="
          position:absolute;
          top:10px;
          left:10px;
          opacity:0;
          pointer-events:none;
          transform:translateY(4px);
          transition:opacity 120ms ease, transform 120ms ease;
          z-index:3;
          min-width:132px;
          padding:10px 12px;
          border-radius:12px;
          background:rgba(24, 30, 39, 0.96);
          border:1px solid rgba(255,255,255,0.08);
          box-shadow:0 14px 30px rgba(0,0,0,0.35);
          color:#fff;
        "
      >
        <div data-chart-tooltip-date style="font-size:12px;font-weight:700;line-height:1.2;"></div>
        <div data-chart-tooltip-price style="margin-top:4px;font-size:22px;font-weight:800;line-height:1;"></div>
      </div>

      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:100%;">
        <defs>
          <linearGradient id="steam-chart-gradient-${escapeHtml(chartId)}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(90, 183, 255, 0.24)"></stop>
            <stop offset="100%" stop-color="rgba(90, 183, 255, 0.01)"></stop>
          </linearGradient>
        </defs>

        ${yLabels.map((tick) => `
          <line
            x1="${paddingLeft}"
            y1="${tick.y.toFixed(1)}"
            x2="${width - paddingRight}"
            y2="${tick.y.toFixed(1)}"
            stroke="rgba(121, 149, 181, 0.10)"
            stroke-width="1"
          ></line>
        `).join("")}

        <path d="${fillPath}" fill="url(#steam-chart-gradient-${escapeHtml(chartId)})"></path>

        <polyline
          fill="none"
          stroke="#5ab7ff"
          stroke-width="3"
          stroke-linejoin="round"
          stroke-linecap="round"
          points="${polyline}"
        ></polyline>

        <line
          data-chart-crosshair-x="${escapeHtml(chartId)}"
          x1="${coords[coords.length - 1].x.toFixed(1)}"
          y1="${paddingTop}"
          x2="${coords[coords.length - 1].x.toFixed(1)}"
          y2="${height - paddingBottom}"
          stroke="rgba(255,255,255,0.18)"
          stroke-width="1"
          opacity="0"
          stroke-dasharray="4 4"
        ></line>

        <circle
          data-chart-marker="${escapeHtml(chartId)}"
          cx="${coords[coords.length - 1].x.toFixed(1)}"
          cy="${coords[coords.length - 1].y.toFixed(1)}"
          r="4.5"
          fill="#5ab7ff"
          stroke="rgba(255,255,255,0.85)"
          stroke-width="1.5"
          opacity="0"
        ></circle>

        ${yLabels.map((tick) => `
          <text
            x="${paddingLeft - 10}"
            y="${(tick.y + 4).toFixed(1)}"
            text-anchor="end"
            fill="rgba(145, 166, 190, 0.95)"
            font-size="11"
          >${escapeHtml(fmtMoney(tick.value))}</text>
        `).join("")}

        ${xLabels.map((tick) => `
          <text
            x="${tick.x.toFixed(1)}"
            y="${height - 10}"
            text-anchor="middle"
            fill="rgba(145, 166, 190, 0.95)"
            font-size="11"
          >${escapeHtml(tick.label)}</text>
        `).join("")}

        ${interactionRects}
      </svg>
    </div>
  `;
}

function wireChartInteractions(scope) {
  scope.querySelectorAll("[data-steam-chart]").forEach((container) => {
    const chartId = container.getAttribute("data-steam-chart");
    if (!chartId) return;

    const tooltip = container.querySelector(`[data-chart-tooltip="${chartId}"]`);
    const tooltipDate = tooltip?.querySelector("[data-chart-tooltip-date]");
    const tooltipPrice = tooltip?.querySelector("[data-chart-tooltip-price]");
    const marker = container.querySelector(`[data-chart-marker="${chartId}"]`);
    const crosshair = container.querySelector(`[data-chart-crosshair-x="${chartId}"]`);
    const hotspots = container.querySelectorAll(`[data-chart-point][data-chart-id="${chartId}"]`);

    const showPoint = (node) => {
      if (!tooltip || !tooltipDate || !tooltipPrice || !marker || !crosshair) return;

      const price = Number(node.getAttribute("data-price"));
      const date = node.getAttribute("data-date") || "";
      const x = Number(node.getAttribute("data-x"));
      const y = Number(node.getAttribute("data-y"));

      tooltipDate.textContent = fmtSteamTooltipDate(date);
      tooltipPrice.textContent = fmtMoney(price);

      tooltip.style.opacity = "1";
      tooltip.style.transform = "translateY(0)";
      tooltip.style.left = `${Math.max(10, Math.min(container.clientWidth - 150, (x / 860) * container.clientWidth - 40))}px`;
      tooltip.style.top = "10px";

      marker.setAttribute("cx", String(x));
      marker.setAttribute("cy", String(y));
      marker.setAttribute("opacity", "1");

      crosshair.setAttribute("x1", String(x));
      crosshair.setAttribute("x2", String(x));
      crosshair.setAttribute("opacity", "1");
    };

    const hidePoint = () => {
      if (!tooltip || !marker || !crosshair) return;
      tooltip.style.opacity = "0";
      tooltip.style.transform = "translateY(4px)";
      marker.setAttribute("opacity", "0");
      crosshair.setAttribute("opacity", "0");
    };

    hotspots.forEach((node) => {
      node.addEventListener("mouseenter", () => showPoint(node));
      node.addEventListener("mousemove", () => showPoint(node));
      node.addEventListener("focus", () => showPoint(node));
    });

    container.addEventListener("mouseleave", hidePoint);
  });
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
    listings: (item) => getResolvedListings(item) ?? -1,
    price: (item) => getResolvedSteamPrice(item) ?? -1,
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
          <strong>${fmtNumber(getResolvedListings(item))}</strong>
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

  const historyVisible = prepareChartHistory(selected, state.chartRange);
  const activityChart = selected.charts?.activity || [];
  const chartId = `case-${selected.key}-${state.chartRange}`;

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
      ${metricCard("Steam price", fmtMoney(getResolvedSteamPrice(selected)), "Taken directly from steam-cases.json")}
      ${metricCard("Listings", fmtNumber(getResolvedListings(selected)), "Steam sell listing count from static dataset")}
      ${metricCard("Burn ratio", selected.metrics?.burnRatio != null ? selected.metrics.burnRatio.toFixed(2) : "—", "Higher historical consumption is better")}
      ${metricCard("12m supply", selected.metrics?.momentum12m != null ? fmtPct(selected.metrics.momentum12m) : "—", "Negative means supply kept shrinking")}
      ${metricCard("Remaining supply", selected.metrics?.remaining != null ? fmtNumber(selected.metrics.remaining) : "—", "Current tracked remaining supply")}
      ${metricCard("Extinction", selected.metrics?.extinctionMonths != null ? `${selected.metrics.extinctionMonths.toFixed(1)} mo` : "—", "Projected scarcity horizon")}
    </section>

    <section class="two-col-grid">
      <article class="panel-card">
        <h3>Supply and activity</h3>
        <div class="chart-shell">${renderSimpleSpark(activityChart, "#35d07f")}</div>
        <div class="market-list" style="margin-top:14px;">
          <div class="market-row"><span>Burn ratio</span><strong>${selected.metrics?.burnRatio != null ? selected.metrics.burnRatio.toFixed(2) : "—"}</strong></div>
          <div class="market-row"><span>12m supply</span><strong>${selected.metrics?.momentum12m != null ? fmtPct(selected.metrics.momentum12m) : "—"}</strong></div>
          <div class="market-row"><span>Remaining</span><strong>${selected.metrics?.remaining != null ? fmtNumber(selected.metrics.remaining) : "—"}</strong></div>
        </div>
      </article>

      <article class="panel-card">
        ${renderChartRangeControls("case")}
        ${renderChartMeta(historyVisible, selected.metrics?.steamChange30dPct ?? null)}
        <div class="chart-shell chart-shell--rich">${renderDatedPriceChart(historyVisible, chartId)}</div>
        <div class="market-list" style="margin-top:14px;">
          <div class="market-row"><span>Current Steam price</span><strong>${fmtMoney(getResolvedSteamPrice(selected))}</strong></div>
          <div class="market-row"><span>7d trend</span><strong>${fmtPct(selected.metrics?.steamChange7dPct)}</strong></div>
          <div class="market-row"><span>30d trend</span><strong>${fmtPct(selected.metrics?.steamChange30dPct)}</strong></div>
          <div class="market-row"><span>Listings</span><strong>${fmtNumber(getResolvedListings(selected))}</strong></div>
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
  `;

  wireChartRangeButtons(target);
  wireChartInteractions(target);
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
        <span>${getResolvedListings(item) != null ? `${fmtNumber(getResolvedListings(item))} listings` : "Listings unknown"}</span>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".skin-card").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedSkinKey = node.dataset.key;
      render();
    });
  });
}

function renderSkinHero(item) {
  const target = $("skinHero");
  if (!item) {
    target.innerHTML = `<div class="empty-state">No skin selected.</div>`;
    return;
  }

  const historyVisible = prepareChartHistory(item, state.chartRange);
  const chartId = `skin-${item.key}-${state.chartRange}`;

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
            ${getResolvedListings(item) != null ? `<span class="metric-pill">${fmtNumber(getResolvedListings(item))} listings</span>` : ""}
          </div>

          <p>
            This skin card is fully fed by the Steam skin scraper output and the static Steam market timeseries cache.
          </p>
        </div>

        <div class="hero-side-actions">
          ${item.listingUrl ? `<a class="btn btn-primary" href="${escapeHtml(item.listingUrl)}" target="_blank" rel="noopener">Steam listing</a>` : ""}
        </div>
      </div>
    </section>

    <section class="metrics-grid">
      ${metricCard("Steam price", fmtMoney(getResolvedSteamPrice(item)), "Taken directly from the skin scraper output")}
      ${metricCard("Listings", getResolvedListings(item) != null ? fmtNumber(getResolvedListings(item)) : "—", "Steam sell listing count")}
      ${metricCard("Quantity", fmtNumber(item.quantity ?? 1), "Grouped quantity in dataset")}
      ${metricCard("30d trend", fmtPct(item.change30dPct), "Taken from static Steam timeseries")}
    </section>

    <section class="two-col-grid">
      <article class="panel-card">
        ${renderChartRangeControls("skin")}
        ${renderChartMeta(historyVisible, item.change30dPct ?? null)}
        <div class="chart-shell chart-shell--rich">${renderDatedPriceChart(historyVisible, chartId)}</div>
        <div class="market-list" style="margin-top:14px;">
          <div class="market-row"><span>Current Steam price</span><strong>${fmtMoney(getResolvedSteamPrice(item))}</strong></div>
          <div class="market-row"><span>7d trend</span><strong>${fmtPct(item.change7dPct)}</strong></div>
          <div class="market-row"><span>30d trend</span><strong>${fmtPct(item.change30dPct)}</strong></div>
          <div class="market-row"><span>Listings</span><strong>${fmtNumber(getResolvedListings(item))}</strong></div>
        </div>
      </article>

      <article class="panel-card">
        <h3>Steam overview</h3>
        <div class="market-list">
          <div class="market-row"><span>Type</span><strong>${escapeHtml(item.type || item.category || "Skin")}</strong></div>
          <div class="market-row"><span>Marketable</span><strong>${item.marketable !== false ? "Yes" : "No"}</strong></div>
          <div class="market-row"><span>Tradable</span><strong>${item.tradable !== false ? "Yes" : "Locked"}</strong></div>
          <div class="market-row"><span>History points</span><strong>${fmtNumber(item.sources?.steamPoints)}</strong></div>
        </div>
      </article>
    </section>
  `;

  wireChartRangeButtons(target);
  wireChartInteractions(target);
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

function wireChartRangeButtons(scope) {
  scope.querySelectorAll("[data-chart-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextRange = button.getAttribute("data-chart-range");
      if (!nextRange || nextRange === state.chartRange) return;
      state.chartRange = nextRange;
      render();
    });
  });
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

  const mostLiquid = [...cases].sort((a, b) => (getResolvedListings(b) ?? -1) - (getResolvedListings(a) ?? -1))[0];
  $("heroDiscount").textContent = mostLiquid?.name || "—";
  $("heroDiscountMeta").textContent = getResolvedListings(mostLiquid) != null
    ? `${fmtNumber(getResolvedListings(mostLiquid))} listings`
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
loadDashboard();
setInterval(() => loadDashboard(true), 10000);