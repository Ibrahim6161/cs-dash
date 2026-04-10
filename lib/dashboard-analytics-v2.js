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
  return String(value || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
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

function classifyItem(name, isCase = false) {
  const lower = cleanText(name).toLowerCase();
  if (isCase || /\bcase\b/.test(lower)) return { key: "case", label: "Case" };
  if (/\bsouvenir\b/.test(lower)) return { key: "souvenir", label: "Souvenir" };
  if (/\bcapsule\b|\bautograph\b|\brmr\b/.test(lower)) return { key: "capsule", label: "Capsule" };
  if (/\bpin\b/.test(lower)) return { key: "pins", label: "Pins" };
  return { key: "container", label: "Container" };
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
      steamPriceEur: safeNum(item.sellPriceEur),
      sellListings: safeNum(item.sellListings),
      listingUrl: buildListingUrl(item.hashName || name),
      iconUrl: iconPath,
      type: cleanText(asset.type) || null,
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

  const items = records.map((item, index) => ({
    key: item.hashName || item.marketHashName || item.name || `skin-${index}`,
    hashName: item.hashName || item.marketHashName || item.name || null,
    name: item.name || item.hashName || null,
    type: normalizeSkinType(item),
    category: item.category || normalizeSkinType(item),
    steamPriceEur: safeNum(item.sellPriceEur),
    sellListings: safeNum(item.sellListings),
    marketable: item.marketable !== false,
    tradable: item.tradable !== false,
    commodity: item.commodity === true,
    iconUrl: item.iconUrl || null,
    listingUrl: item.marketUrl || (item.hashName ? buildListingUrl(item.hashName) : null),
    quantity: safeNum(item.quantity) ?? 1,
    assetDescription: item.assetDescription || {},
    fetchedAt: toIso(raw?.fetchedAt),
  }));

  return {
    timestamp: toIso(raw?.fetchedAt),
    skinCount: safeNum(raw?.skinCount ?? items.length),
    items,
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

function buildDashboard(root, config, extra = {}) {
  const paths = config.paths;

  const casesRaw = readJson(path.resolve(root, paths.cases)) || { cases: [] };
  const details = extractDetails(readJson(path.resolve(root, paths.details)) || {}, paths.shotsDir);
  const steamCases = extractSteamCases(readJson(path.resolve(root, paths.steamCases || "out/steam-cases.json")) || {});
  const steamSkins = extractSteamSkins(readJson(path.resolve(root, paths.steamSkins || "out/steam-skins.json")) || {});
  const timeseries = extractTimeseries(readJson(path.resolve(root, paths.timeseries)) || {});

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
  ]);

  const items = [];
  for (const key of allCaseKeys) {
    const base = caseMap.get(key) || null;
    const detail = details.map[key] || null;
    const steamEntry = steamCases.map[key] || null;

    const name = cleanText(base?.case || detail?.case || steamEntry?.name || key);
    if (!name) continue;

    const isCase = true;
    const category = classifyItem(name, isCase);
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
        steamPriceEur: steamEntry?.steamPriceEur ?? null,
        steamMedianEur: steamEntry?.steamPriceEur ?? null,
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
        steamChange7dPct: null,
        steamChange30dPct: null,
        steamChange90dPct: null,
        steamVolatility30dPct: null,
        steamListings: steamEntry?.sellListings ?? null,
        unboxingChange6Pct: timeseries.map[key]?.change6Pct ?? null,
      },
      charts: {
        steam: [],
        activity: timeseries.map[key]?.spark || [],
      },
      sourceCoverage: {
        csstonks: !!detail,
        steam: !!steamEntry,
        timeseries: !!timeseries.map[key],
      },
      sources: {
        steamPoints: 0,
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
    const values = items.map((item) => item.metrics.remaining).filter((value) => value != null && Number.isFinite(value));
    return values.length ? [Math.min(...values), Math.max(...values)] : [0, 1];
  })();

  const [minVolume, maxVolume] = (() => {
    const values = items.map((item) => item.price.steamVolume).filter((value) => value != null && Number.isFinite(value));
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
      0.28 +
      (item.sourceCoverage.csstonks ? 0.28 : 0) +
      (item.sourceCoverage.steam ? 0.28 : 0) +
      (item.sourceCoverage.timeseries ? 0.16 : 0)
    );

    const invest = weightedScore([
      { value: scarcity, weight: 0.25 },
      { value: burn, weight: 0.20 },
      { value: supplyTrend, weight: 0.18 },
      { value: liquidity, weight: 0.17 },
      { value: extinction, weight: 0.10 },
      { value: confidence, weight: 0.10 },
    ], 0.48);

    const risk = clamp01(
      (0.28 * (scarcity == null ? 0.5 : 1 - scarcity)) +
      (0.18 * (burn == null ? 0.55 : 1 - burn)) +
      (0.18 * (supplyTrend == null ? 0.55 : 1 - supplyTrend)) +
      (0.16 * (liquidity == null ? 0.55 : 1 - liquidity)) +
      (0.20 * (1 - confidence))
    );

    const entry = clamp01((0.72 * invest) + (0.28 * confidence) - (0.34 * risk));
    const total = clamp01((0.70 * entry) + (0.20 * confidence) + (0.10 * (liquidity ?? 0.5)));

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
        note: "Taken directly from the Steam market scrape.",
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

  const skins = steamSkins.items.map((item, index) => ({
    ...item,
    key: item.key || item.hashName || `skin-${index}`,
    unitPriceEur: item.steamPriceEur,
    totalPriceEur: item.steamPriceEur != null ? item.steamPriceEur * (item.quantity ?? 1) : null,
    change30dPct: null,
  }));

  const sourceTimestamps = [
    toIso(casesRaw?.timestamp),
    details.timestamp,
    steamCases.timestamp,
    steamSkins.timestamp,
    timeseries.timestamp,
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
      shots: {
        label: "Screenshots",
        path: paths.shotsDir,
        exists: fs.existsSync(path.resolve(root, paths.shotsDir)),
      },
    },
    refreshHealth: {
      hasSteamCases: !!steamCases.timestamp,
      hasSteamSkins: !!steamSkins.timestamp,
      totalTrackedCases: items.length,
      totalTrackedSkins: skins.length,
      caseCoverage: items.filter((item) => item.sourceCoverage.csstonks).length,
      steamCaseCoverage: items.filter((item) => item.sourceCoverage.steam).length,
    },
    items,
    skins,
    refresh: extra.refresh || null,
  };
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

module.exports = {
  buildDashboard,
  normalizeName,
};