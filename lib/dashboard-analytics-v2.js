const fs = require("fs");
const path = require("path");
const { buildListingUrl } = require("./steam-market");

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNum(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function fileInfo(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: relativePath,
      exists: false,
      updatedAt: null,
      size: 0,
    };
  }

  const stat = fs.statSync(absolutePath);
  return {
    path: relativePath,
    exists: true,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
  };
}

function percentile(values, q) {
  const finite = values
    .filter((value) => value != null && Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!finite.length) return null;
  const index = Math.max(0, Math.min(finite.length - 1, Math.floor(q * (finite.length - 1))));
  return finite[index];
}

function scale01(value, min, max, invert = false) {
  if (value == null || !Number.isFinite(value)) return null;
  if (min === max) return 0.5;
  const scaled = clamp01((value - min) / (max - min));
  return invert ? 1 - scaled : scaled;
}

function weightedScore(parts, fallback = 0.5) {
  let weighted = 0;
  let weights = 0;

  for (const part of parts) {
    if (part.value == null || !Number.isFinite(part.value)) continue;
    weighted += part.value * part.weight;
    weights += part.weight;
  }

  if (!weights) return fallback;
  return clamp01(weighted / weights);
}

function toWebPath(relativePath) {
  const bits = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent);

  return bits.length ? `/${bits.join("/")}` : null;
}

function classifyItem(name) {
  const lower = cleanText(name).toLowerCase();

  if (!lower) {
    return { key: "other", label: "Other" };
  }

  if (/\bsouvenir\b/.test(lower) && /\bpackage\b/.test(lower)) {
    return { key: "souvenir", label: "Souvenir" };
  }

  if (
    /\bsticker capsule\b/.test(lower) ||
    /\bautograph capsule\b/.test(lower) ||
    /\bcapsule\b/.test(lower) ||
    /\brmr\b/.test(lower)
  ) {
    return { key: "capsule", label: "Capsule" };
  }

  if (
    /\bsticker\b/.test(lower) ||
    /\bfoil\b/.test(lower) ||
    /\bholo\b/.test(lower) ||
    /\bglitter\b/.test(lower) ||
    /\bgold\b/.test(lower) ||
    /\blenticular\b/.test(lower)
  ) {
    return { key: "sticker", label: "Sticker" };
  }

  if (/\bcollection package\b/.test(lower) || /\bpackage\b/.test(lower)) {
    return { key: "package", label: "Package" };
  }

  if (/\bgraffiti\b/.test(lower) || /\bsealed graffiti\b/.test(lower)) {
    return { key: "graffiti", label: "Graffiti" };
  }

  if (/\bpatch\b/.test(lower) || /\bpatch pack\b/.test(lower)) {
    return { key: "patch", label: "Patch" };
  }

  if (/\bmusic kit\b/.test(lower) || /\bkit box\b/.test(lower)) {
    return { key: "music_kit", label: "Music Kit" };
  }

  if (/\bpin\b/.test(lower) || /\bpins\b/.test(lower)) {
    return { key: "pin", label: "Pin" };
  }

  if (/\bviewer pass\b/.test(lower) || /\boperation pass\b/.test(lower) || /\bpass\b/.test(lower)) {
    return { key: "pass", label: "Pass" };
  }

  if (/\bkey\b/.test(lower)) {
    return { key: "key", label: "Key" };
  }

  if (/\bgift\b/.test(lower)) {
    return { key: "gift", label: "Gift" };
  }

  if (
    /\bname tag\b/.test(lower) ||
    /\bstattrak swap tool\b/.test(lower) ||
    /\bstorage unit\b/.test(lower) ||
    /\btool\b/.test(lower)
  ) {
    return { key: "tool", label: "Tool" };
  }

  if (/\bweapon case\b/.test(lower) || /\bcase\b/.test(lower)) {
    return { key: "case", label: "Case" };
  }

  if (/\bbox\b/.test(lower) || /\bcontainer\b/.test(lower)) {
    return { key: "container", label: "Container" };
  }

  return { key: "other", label: "Other" };
}

function compactSpark(values, maxPoints = 24) {
  const finite = (Array.isArray(values) ? values : [])
    .map(safeNum)
    .filter((value) => value != null);
  return finite.slice(-maxPoints);
}

function extractDetails(raw, shotsDir) {
  const records = Array.isArray(raw?.cases) ? raw.cases : [];
  const map = {};

  for (const record of records) {
    const name = record.case || record.name;
    if (!name) continue;

    const pageCards = record.pageCards || {};
    const extinction = pageCards.extinction || {};
    const screenshots = record.screenshots || {};
    const chartName = screenshots.chart ? path.basename(screenshots.chart) : null;
    const pageName = screenshots.page ? path.basename(screenshots.page) : null;

    map[normalizeName(name)] = {
      case: name,
      url: record.url || null,
      remaining: safeNum(record.remaining ?? record.totals?.remaining ?? pageCards.currentRemainingSupply),
      dropped: safeNum(record.dropped ?? record.totals?.dropped),
      unboxed: safeNum(record.unboxed ?? record.totals?.unboxed),
      price: safeNum(record.price ?? record.totals?.price ?? pageCards.priceUSD),
      marketCap: safeNum(record.marketCap ?? record.totals?.marketCap ?? pageCards.marketCapUSD),
      delta1m: safeNum(record.delta1m ?? pageCards.delta1m?.percent ?? pageCards.delta1m),
      delta6m: safeNum(record.delta6m ?? pageCards.delta6m?.percent ?? pageCards.delta6m),
      delta12m: safeNum(record.delta12m ?? pageCards.delta12m?.percent ?? pageCards.delta12m),
      extinctionMonths: safeNum(record.extinctionMonths ?? extinction.months),
      extinctionDate: record.extinctionDate || extinction.approxDate || null,
      screenshots: {
        chartUrl: chartName ? toWebPath(path.join(shotsDir, chartName)) : null,
        pageUrl: pageName ? toWebPath(path.join(shotsDir, pageName)) : null,
      },
    };
  }

  return {
    timestamp: toIso(raw?.timestamp),
    map,
  };
}

function extractTimeseries(raw) {
  const base = raw?.out && typeof raw.out === "object" ? raw.out : {};
  const map = {};

  for (const [name, entry] of Object.entries(base)) {
    const unboxings = Array.isArray(entry?.unboxings)
      ? entry.unboxings.map(safeNum).filter((value) => value != null)
      : [];

    const dates = Array.isArray(entry?.dates) ? entry.dates : [];
    const recent = unboxings.slice(-6);
    const previous = unboxings.slice(-12, -6);
    const recentAvg = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null;
    const previousAvg = previous.length ? previous.reduce((sum, value) => sum + value, 0) / previous.length : null;

    map[normalizeName(name)] = {
      dates,
      unboxings,
      spark: compactSpark(unboxings, 24),
      change6Pct: recentAvg && previousAvg ? ((recentAvg - previousAvg) / previousAvg) * 100 : null,
    };
  }

  return {
    timestamp: toIso(raw?.generatedAt),
    failures: Array.isArray(raw?.failures) ? raw.failures : [],
    map,
  };
}

function extractSteamCases(raw) {
  const records = Array.isArray(raw?.items) ? raw.items : [];
  const map = {};

  for (const item of records) {
    const name = cleanText(item.hashName || item.name || item.assetDescription?.market_hash_name);
    if (!name) continue;

    const asset = item.assetDescription || {};
    const iconPath = asset.icon_url
      ? `https://community.fastly.steamstatic.com/economy/image/${asset.icon_url}/360fx360f`
      : null;

    map[normalizeName(name)] = {
      name,
      hashName: item.hashName || name,
      steamPriceEur: safeNum(item.sellPriceEur ?? item.steamPriceEur),
      sellListings: safeNum(item.sellListings),
      listingUrl: item.marketUrl || item.listingUrl || buildListingUrl(item.hashName || name),
      iconUrl: item.iconUrl || iconPath,
      type: cleanText(asset.type || item.type) || null,
      fetchedAt: toIso(raw?.fetchedAt),
      assetDescription: asset,
    };
  }

  return {
    timestamp: toIso(raw?.fetchedAt),
    totalCountReported: safeNum(raw?.totalCountReported),
    map,
  };
}

function normalizeSkinType(item) {
  const raw = cleanText(item?.category || item?.type || item?.assetDescription?.type);
  if (raw) return raw;
  return "Other";
}

function extractSteamSkins(raw) {
  const records = Array.isArray(raw?.items) ? raw.items : [];

  const items = records.map((item, index) => {
    const hashName = item.hashName || item.marketHashName || item.name || `skin-${index}`;
    return {
      key: hashName,
      hashName,
      name: item.name || hashName,
      type: normalizeSkinType(item),
      category: item.category || normalizeSkinType(item),
      steamPriceEur: safeNum(item.sellPriceEur ?? item.steamPriceEur),
      sellListings: safeNum(item.sellListings),
      marketable: item.marketable !== false,
      tradable: item.tradable !== false,
      commodity: item.commodity === true,
      iconUrl: item.iconUrl || null,
      listingUrl: item.marketUrl || item.listingUrl || (hashName ? buildListingUrl(hashName) : null),
      quantity: safeNum(item.quantity) ?? 1,
      assetDescription: item.assetDescription || {},
      fetchedAt: toIso(raw?.fetchedAt),
    };
  });

  return {
    timestamp: toIso(raw?.fetchedAt),
    skinCount: safeNum(raw?.skinCount ?? items.length),
    items,
  };
}

function normalizeMarketHistoryPoint(point) {
  if (point == null) return null;

  if (typeof point === "number") {
    return { date: null, priceEur: safeNum(point), volume: null };
  }

  if (typeof point !== "object") return null;

  const priceEur = safeNum(
    point.priceEur ??
      point.price ??
      point.value ??
      point.close ??
      point.medianPriceEur ??
      point.lowestPriceEur ??
      point.sellPriceEur
  );

  if (priceEur == null) return null;

  return {
    date: point.date || point.time || point.timestamp || point.x || null,
    priceEur,
    volume: safeNum(point.volume),
  };
}

function computeSeriesStats(points) {
  const chart = points.map((point) => point.priceEur).filter((value) => value != null);

  const avg = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  const pct = (recent, previous) => {
    if (recent == null || previous == null || previous === 0) return null;
    return ((recent - previous) / previous) * 100;
  };

  const last7 = chart.slice(-7);
  const prev7 = chart.slice(-14, -7);
  const last30 = chart.slice(-30);
  const prev30 = chart.slice(-60, -30);
  const last90 = chart.slice(-90);
  const prev90 = chart.slice(-180, -90);

  const avg30 = avg(last30);
  const volatility30dPct =
    avg30 && last30.length >= 2
      ? (() => {
          const variance = last30.reduce((sum, value) => sum + Math.pow(value - avg30, 2), 0) / last30.length;
          const stdDev = Math.sqrt(variance);
          return avg30 === 0 ? null : (stdDev / avg30) * 100;
        })()
      : null;

  return {
    latestPriceEur: chart.length ? chart[chart.length - 1] : null,
    change7dPct: pct(avg(last7), avg(prev7)),
    change30dPct: pct(avg(last30), avg(prev30)),
    change90dPct: pct(avg(last90), avg(prev90)),
    volatility30dPct,
    spark: compactSpark(chart, 60),
  };
}

function extractSteamMarketTimeseries(raw) {
  const records = Array.isArray(raw?.items) ? raw.items : [];
  const map = {};

  for (const item of records) {
    const name = cleanText(item.hashName || item.marketHashName || item.name || item.case);
    if (!name) continue;

    const historyRaw =
      item.history ||
      item.prices ||
      item.points ||
      item.values ||
      item.series ||
      [];

    const points = (Array.isArray(historyRaw) ? historyRaw : [])
      .map(normalizeMarketHistoryPoint)
      .filter((point) => point && point.priceEur != null);

    const summary = item.summary && typeof item.summary === "object" ? item.summary : {};
    const computed = computeSeriesStats(points);

    map[normalizeName(name)] = {
      name,
      category: cleanText(item.category) || null,
      type: cleanText(item.type) || null,
      fetchedAt: toIso(item.fetchedAt || raw?.fetchedAt),
      points,
      latestPriceEur: safeNum(summary.latestPriceEur) ?? computed.latestPriceEur,
      change7dPct: safeNum(summary.change7dPct) ?? computed.change7dPct,
      change30dPct: safeNum(summary.change30dPct) ?? computed.change30dPct,
      change90dPct: safeNum(summary.change90dPct) ?? computed.change90dPct,
      volatility30dPct: safeNum(summary.volatility30dPct) ?? computed.volatility30dPct,
      spark:
        Array.isArray(summary.spark) && summary.spark.length
          ? compactSpark(summary.spark, 60)
          : computed.spark,
      low30dEur: safeNum(summary.low30dEur),
      high30dEur: safeNum(summary.high30dEur),
      avgVolume30d: safeNum(summary.avgVolume30d),
    };
  }

  return {
    timestamp: toIso(raw?.fetchedAt || raw?.timestamp || raw?.generatedAt),
    count: records.length,
    map,
  };
}

function compactItem(item) {
  return {
    name: item.name,
    category: item.category.label,
    score: item.scores.total,
    entry: item.scores.entry,
    risk: item.scores.risk,
    confidence: item.scores.confidence,
    grade: item.grade,
    steamEur: item.price.steamPriceEur,
    listings: item.price.steamVolume,
    change30dPct: item.metrics.steamChange30dPct,
  };
}

function driverTone(score) {
  if (score == null) return "warn";
  if (score >= 0.62) return "good";
  if (score <= 0.38) return "bad";
  return "warn";
}

function fmtInt(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtMoneyInternal(value) {
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(value);
}

function buildDashboard(root, config, extra = {}) {
  const paths = config.paths || {};

  const casesRaw = readJson(path.resolve(root, paths.cases)) || { cases: [] };
  const details = extractDetails(readJson(path.resolve(root, paths.details)) || {}, paths.shotsDir);
  const steamCases = extractSteamCases(readJson(path.resolve(root, paths.steamCases || "out/steam-cases.json")) || {});
  const steamSkins = extractSteamSkins(readJson(path.resolve(root, paths.steamSkins || "out/steam-skins.json")) || {});
  const timeseries = extractTimeseries(readJson(path.resolve(root, paths.timeseries)) || {});
  const steamMarketTimeseries = extractSteamMarketTimeseries(
    readJson(path.resolve(root, paths.steamMarketTimeseries || "out/steam-market-timeseries.json")) || {}
  );

  const cases = Array.isArray(casesRaw?.cases) ? casesRaw.cases : [];
  const caseMap = new Map();
  for (const entry of cases) {
    const name = cleanText(entry.case || entry.name);
    if (!name) continue;
    caseMap.set(normalizeName(name), entry);
  }

  const allCaseKeys = new Set([
    ...caseMap.keys(),
    ...Object.keys(details.map || {}),
    ...Object.keys(steamCases.map || {}),
    ...Object.keys(timeseries.map || {}),
  ]);

  const items = [];
  for (const key of allCaseKeys) {
    const base = caseMap.get(key) || null;
    const detail = details.map[key] || null;
    const steamEntry = steamCases.map[key] || null;
    const marketHistory = steamMarketTimeseries.map[key] || null;

    const name = cleanText(base?.case || detail?.case || steamEntry?.name || marketHistory?.name || key);
    if (!name) continue;

    const category = classifyItem(name);
    const isCase = category.key === "case";

    const remaining = safeNum(base?.remaining ?? detail?.remaining);
    const dropped = safeNum(base?.dropped ?? detail?.dropped);
    const unboxed = safeNum(base?.unboxed ?? detail?.unboxed);
    const burnRatio = dropped && unboxed != null ? unboxed / dropped : null;

    items.push({
      key,
      name,
      isCase,
      category,
      urls: {
        csstonks: detail?.url || null,
        steam: steamEntry?.listingUrl || buildListingUrl(name),
      },
      media: {
        iconUrl: steamEntry?.iconUrl || null,
      },
      screenshots: detail?.screenshots || { chartUrl: null, pageUrl: null },
      price: {
        steamPriceEur: steamEntry?.steamPriceEur ?? marketHistory?.latestPriceEur ?? null,
        steamMedianEur: steamEntry?.steamPriceEur ?? marketHistory?.latestPriceEur ?? null,
        steamVolume: steamEntry?.sellListings ?? null,
      },
      metrics: {
        remaining,
        dropped,
        unboxed,
        burnRatio,
        momentum1m: detail?.delta1m ?? null,
        momentum6m: detail?.delta6m ?? null,
        momentum12m: detail?.delta12m ?? null,
        extinctionMonths: detail?.extinctionMonths ?? null,
        extinctionDate: detail?.extinctionDate ?? null,
        steamChange7dPct: marketHistory?.change7dPct ?? null,
        steamChange30dPct: marketHistory?.change30dPct ?? null,
        steamChange90dPct: marketHistory?.change90dPct ?? null,
        steamVolatility30dPct: marketHistory?.volatility30dPct ?? null,
        steamListings: steamEntry?.sellListings ?? null,
        unboxingChange6Pct: timeseries.map[key]?.change6Pct ?? null,
      },
      charts: {
        steam: marketHistory?.spark || [],
        steamHistory: marketHistory?.points || [],
        activity: timeseries.map[key]?.spark || [],
      },
      sourceCoverage: {
        csstonks: !!detail,
        steam: !!steamEntry,
        timeseries: !!timeseries.map[key],
        steamChart: !!marketHistory,
      },
      sources: {
        steamPoints: Array.isArray(marketHistory?.points) ? marketHistory.points.length : 0,
      },
      scores: {
        total: null,
        entry: null,
        risk: null,
        confidence: null,
        scarcity: null,
        trend: null,
        liquidity: null,
      },
      drivers: [],
      thesis: [],
      risks: [],
      grade: {
        label: "WARN",
        tone: "warn",
        reason: "Mixed setup",
      },
      summary: "",
    });
  }

  const [minRemaining, maxRemaining] = (() => {
    const values = items
      .map((item) => item.metrics.remaining)
      .filter((value) => value != null && Number.isFinite(value));
    return values.length ? [Math.min(...values), Math.max(...values)] : [0, 1];
  })();

  const [minVolume, maxVolume] = (() => {
    const values = items
      .map((item) => item.price.steamVolume)
      .filter((value) => value != null && Number.isFinite(value));
    return values.length ? [Math.min(...values), Math.max(...values)] : [0, 1];
  })();

  for (const item of items) {
    const scarcity = scale01(item.metrics.remaining, minRemaining, maxRemaining, true);
    const burn = item.metrics.burnRatio != null ? clamp01(item.metrics.burnRatio) : null;
    const supplyTrend = item.metrics.momentum12m != null
      ? clamp01((6 - item.metrics.momentum12m) / 12)
      : null;
    const liquidity = scale01(item.price.steamVolume, minVolume, maxVolume, false);

    const extinction = item.metrics.extinctionMonths != null
      ? item.metrics.extinctionMonths <= 48
        ? 1
        : item.metrics.extinctionMonths <= 96
          ? 0.72
          : 0.35
      : null;

    const confidence = clamp01(
      0.24 +
        (item.sourceCoverage.csstonks ? 0.24 : 0) +
        (item.sourceCoverage.steam ? 0.20 : 0) +
        (item.sourceCoverage.timeseries ? 0.14 : 0) +
        (item.sourceCoverage.steamChart ? 0.18 : 0)
    );

    const invest = weightedScore(
      [
        { value: scarcity, weight: 0.25 },
        { value: burn, weight: 0.20 },
        { value: supplyTrend, weight: 0.18 },
        { value: liquidity, weight: 0.17 },
        { value: extinction, weight: 0.10 },
        { value: confidence, weight: 0.10 },
      ],
      0.48
    );

    const risk = clamp01(
      0.28 * (scarcity == null ? 0.5 : 1 - scarcity) +
        0.18 * (burn == null ? 0.55 : 1 - burn) +
        0.18 * (supplyTrend == null ? 0.55 : 1 - supplyTrend) +
        0.16 * (liquidity == null ? 0.55 : 1 - liquidity) +
        0.20 * (1 - confidence)
    );

    const entry = clamp01(0.72 * invest + 0.28 * confidence - 0.34 * risk);
    const total = clamp01(0.70 * entry + 0.20 * confidence + 0.10 * (liquidity ?? 0.5));

    item.scores.total = total;
    item.scores.entry = entry;
    item.scores.risk = risk;
    item.scores.confidence = confidence;
    item.scores.scarcity = scarcity;
    item.scores.trend = supplyTrend;
    item.scores.liquidity = liquidity;

    const drivers = [
      {
        key: "scarcity",
        label: "Scarcity",
        score: scarcity,
        value: item.metrics.remaining,
        valueText: item.metrics.remaining == null ? "No data" : fmtInt(item.metrics.remaining),
        note: "Lower remaining supply lifts the score.",
      },
      {
        key: "burn",
        label: "Burn ratio",
        score: burn,
        value: item.metrics.burnRatio,
        valueText: item.metrics.burnRatio == null ? "No data" : item.metrics.burnRatio.toFixed(2),
        note: "Higher historical consumption is better.",
      },
      {
        key: "supplyTrend",
        label: "12m supply",
        score: supplyTrend,
        value: item.metrics.momentum12m,
        valueText: item.metrics.momentum12m == null ? "No data" : `${item.metrics.momentum12m.toFixed(1)}%`,
        note: "Negative means supply kept shrinking.",
      },
      {
        key: "steamPrice",
        label: "Steam price",
        score: item.price.steamPriceEur != null ? 0.55 : null,
        value: item.price.steamPriceEur,
        valueText: item.price.steamPriceEur == null ? "No price" : fmtMoneyInternal(item.price.steamPriceEur),
        note: "Taken directly from the Steam market scrape cache.",
      },
      {
        key: "listings",
        label: "Listings",
        score: liquidity,
        value: item.price.steamVolume,
        valueText: item.price.steamVolume == null ? "No data" : `${fmtInt(item.price.steamVolume)} listings`,
        note: "Higher listing count improves tradability.",
      },
      {
        key: "confidence",
        label: "Confidence",
        score: confidence,
        value: confidence,
        valueText: `${Math.round(confidence * 100)}%`,
        note: "More source coverage means a cleaner read.",
      },
    ].filter((driver) => driver.value != null || driver.key === "confidence");

    item.drivers = drivers
      .sort((left, right) => Math.abs((right.score ?? 0.5) - 0.5) - Math.abs((left.score ?? 0.5) - 0.5))
      .map((driver) => ({ ...driver, tone: driverTone(driver.score) }));

    const positives = item.drivers.filter((driver) => (driver.score ?? 0.5) >= 0.62).slice(0, 3);
    const negatives = item.drivers.filter((driver) => (driver.score ?? 0.5) <= 0.38).slice(0, 3);

    item.thesis = positives.length
      ? positives.map((driver) => `${driver.label}: ${driver.note}`)
      : ["No single driver is dominant yet; this is more watchlist than conviction."];

    item.risks = negatives.length
      ? negatives.map((driver) => `${driver.label}: ${driver.note}`)
      : ["Main risk is execution timing rather than one obvious weak signal."];

    item.summary = positives.length
      ? positives.map((driver) => driver.label.toLowerCase()).join(" + ")
      : "Mixed watchlist setup";
  }

  const goodThreshold = percentile(items.map((item) => item.scores.total), 0.68);
  const badThreshold = percentile(items.map((item) => item.scores.total), 0.34);

  for (const item of items) {
    if (goodThreshold != null && item.scores.total >= goodThreshold) {
      item.grade = { label: "GOOD", tone: "good", reason: item.summary };
    } else if (badThreshold != null && item.scores.total <= badThreshold) {
      item.grade = { label: "BAD", tone: "bad", reason: item.summary };
    } else {
      item.grade = { label: "WARN", tone: "warn", reason: item.summary };
    }
  }

  items.sort((left, right) => (right.scores.total ?? 0) - (left.scores.total ?? 0));
  items.forEach((item, index) => {
    item.rank = index + 1;
  });

  const skins = steamSkins.items.map((item, index) => {
    const marketHistory =
      steamMarketTimeseries.map[normalizeName(item.hashName || item.name || item.key)] || null;

    const resolvedUnitPrice = item.steamPriceEur ?? marketHistory?.latestPriceEur ?? null;

    return {
      ...item,
      key: item.key || item.hashName || `skin-${index}`,
      unitPriceEur: resolvedUnitPrice,
      totalPriceEur:
        resolvedUnitPrice != null ? resolvedUnitPrice * (item.quantity ?? 1) : null,
      change7dPct: marketHistory?.change7dPct ?? null,
      change30dPct: marketHistory?.change30dPct ?? null,
      change90dPct: marketHistory?.change90dPct ?? null,
      volatility30dPct: marketHistory?.volatility30dPct ?? null,
      charts: {
        steam: marketHistory?.spark || [],
        steamHistory: marketHistory?.points || [],
      },
      sourceCoverage: {
        steam: true,
        steamChart: !!marketHistory,
      },
      sources: {
        steamPoints: Array.isArray(marketHistory?.points) ? marketHistory.points.length : 0,
      },
    };
  });

  const sourceTimestamps = [
    toIso(casesRaw?.timestamp),
    details.timestamp,
    steamCases.timestamp,
    steamSkins.timestamp,
    timeseries.timestamp,
    steamMarketTimeseries.timestamp,
  ].filter(Boolean);
  const updatedAt = sourceTimestamps.sort().slice(-1)[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    updatedAt,
    overview: {
      totalItems: items.length + skins.length,
      totalCases: items.length,
      marketOnlyCount: skins.length,
      goodCount: items.filter((item) => item.grade.label === "GOOD").length,
      warnCount: items.filter((item) => item.grade.label === "WARN").length,
      badCount: items.filter((item) => item.grade.label === "BAD").length,
      topCandidate: items[0] ? compactItem(items[0]) : null,
      bestDiscount: null,
      strongestSteamTrend: null,
    },
    diagnostics: [
      !steamCases.timestamp ? "steam-cases.json is missing, so case pricing is unavailable." : null,
      !steamSkins.timestamp ? "steam-skins.json is missing, so the skins tab is empty." : null,
      timeseries.failures.length ? `CSStonks timeseries still fails for ${timeseries.failures.length} case(s).` : null,
      !steamMarketTimeseries.timestamp ? "steam-market-timeseries.json is missing, so Steam price charts are unavailable." : null,
    ].filter(Boolean),
    sources: {
      cases: { label: "Cases", ...fileInfo(root, paths.cases), timestamp: toIso(casesRaw?.timestamp) },
      details: { label: "Case details", ...fileInfo(root, paths.details), timestamp: details.timestamp },
      steamCases: {
        label: "Steam cases",
        ...fileInfo(root, paths.steamCases || "out/steam-cases.json"),
        timestamp: steamCases.timestamp,
        matched: Object.keys(steamCases.map).length,
      },
      steamSkins: {
        label: "Steam skins",
        ...fileInfo(root, paths.steamSkins || "out/steam-skins.json"),
        timestamp: steamSkins.timestamp,
        matched: skins.length,
      },
      timeseries: {
        label: "CSStonks timeseries",
        ...fileInfo(root, paths.timeseries),
        timestamp: timeseries.timestamp,
        failures: timeseries.failures.length,
      },
      steamMarketTimeseries: {
        label: "Steam market timeseries",
        ...fileInfo(root, paths.steamMarketTimeseries || "out/steam-market-timeseries.json"),
        timestamp: steamMarketTimeseries.timestamp,
        matched: Object.keys(steamMarketTimeseries.map).length,
      },
      shots: {
        label: "Screenshots",
        path: paths.shotsDir,
        exists: fs.existsSync(path.resolve(root, paths.shotsDir)),
      },
    },
    refreshHealth: {
      hasSteamCases: !!steamCases.timestamp,
      hasSteamSkins: !!steamSkins.timestamp,
      hasSteamMarketTimeseries: !!steamMarketTimeseries.timestamp,
      totalTrackedCases: items.length,
      totalTrackedSkins: skins.length,
      caseCoverage: items.filter((item) => item.sourceCoverage.csstonks).length,
      steamCaseCoverage: items.filter((item) => item.sourceCoverage.steam).length,
      steamCaseChartCoverage: items.filter((item) => item.sourceCoverage.steamChart).length,
      steamSkinChartCoverage: skins.filter((item) => item.sourceCoverage.steamChart).length,
    },
    items,
    skins,
    refresh: extra.refresh || null,
  };
}

module.exports = {
  buildDashboard,
  normalizeName,
};