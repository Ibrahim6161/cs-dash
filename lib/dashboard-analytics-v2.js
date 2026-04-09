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
  const finite = values.filter((value) => value != null && Number.isFinite(value)).sort((a, b) => a - b);
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
  const finite = (Array.isArray(values) ? values : []).map(safeNum).filter((value) => value != null);
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

function extractMarketplaceCollection(raw) {
  const base = raw?.map && typeof raw.map === "object" ? raw.map : {};
  const map = {};

  for (const [name, entries] of Object.entries(base)) {
    if (!Array.isArray(entries) || !entries.length) continue;
    const prices = entries
      .map((entry) => ({
        providerKey: cleanText(entry.providerKey || "skinbaron").toLowerCase(),
        providerName: cleanText(entry.providerName || "SkinBaron") || "SkinBaron",
        value: safeNum(entry.value),
        count: safeNum(entry.count),
        updatedAt: toIso(entry.updatedAt),
        lastCheckedAt: toIso(entry.lastCheckedAt),
        sourceCurrency: cleanText(entry.sourceCurrency || "EUR") || "EUR",
        url: entry.url || null,
        image: entry.image || null,
        collection: cleanText(entry.collection) || null,
        category: cleanText(entry.category) || null,
      }))
      .filter((entry) => entry.value != null)
      .sort((left, right) => left.value - right.value);

    if (!prices.length) continue;
    map[normalizeName(name)] = { case: name, prices };
  }

  return {
    timestamp: toIso(raw?.meta?.timestamp || raw?.timestamp),
    map,
    providerCount: 1,
    errors: Array.isArray(raw?.errors) ? raw.errors : [],
  };
}

function extractTimeseries(raw) {
  const base = raw?.out && typeof raw.out === "object" ? raw.out : {};
  const map = {};

  for (const [name, entry] of Object.entries(base)) {
    const unboxings = Array.isArray(entry?.unboxings) ? entry.unboxings.map(safeNum).filter((value) => value != null) : [];
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

function extractSteamCollection(raw) {
  const base = raw?.map && typeof raw.map === "object" ? raw.map : {};
  const map = {};

  for (const [name, entry] of Object.entries(base)) {
    map[normalizeName(name)] = {
      name,
      fetchedAt: toIso(entry?.fetchedAt),
      listingUrl: entry?.listingUrl || buildListingUrl(name),
      itemNameId: entry?.itemNameId || null,
      lowestPriceEur: safeNum(entry?.overview?.lowestPriceEur),
      medianPriceEur: safeNum(entry?.overview?.medianPriceEur),
      volume: safeNum(entry?.overview?.volume),
      latestPriceEur: safeNum(entry?.summary?.latestPriceEur),
      change7dPct: safeNum(entry?.summary?.change7dPct),
      change30dPct: safeNum(entry?.summary?.change30dPct),
      change90dPct: safeNum(entry?.summary?.change90dPct),
      low30dEur: safeNum(entry?.summary?.low30dEur),
      high30dEur: safeNum(entry?.summary?.high30dEur),
      avgVolume30d: safeNum(entry?.summary?.avgVolume30d),
      volatility30dPct: safeNum(entry?.summary?.volatility30dPct),
      spark: compactSpark(entry?.summary?.spark || (entry?.history || []).map((point) => point?.price), 24),
      historyCount: Array.isArray(entry?.history) ? entry.history.length : 0,
    };
  }

  return {
    timestamp: toIso(raw?.meta?.timestamp || raw?.timestamp),
    map,
    errors: Array.isArray(raw?.errors) ? raw.errors : [],
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
    skinbaronEur: item.price.skinbaronFloorEur,
    steamEur: item.price.steamPriceEur,
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
  const skinbaron = extractMarketplaceCollection(readJson(path.resolve(root, paths.pricempire)) || {});
  const steam = extractSteamCollection(readJson(path.resolve(root, paths.steam || "steam_market_data.json")) || {});
  const timeseries = extractTimeseries(readJson(path.resolve(root, paths.timeseries)) || {});

  const cases = Array.isArray(casesRaw?.cases) ? casesRaw.cases : [];
  const caseMap = new Map();
  for (const entry of cases) {
    const name = cleanText(entry.case || entry.name);
    if (!name) continue;
    caseMap.set(normalizeName(name), entry);
  }

  const allKeys = new Set([
    ...caseMap.keys(),
    ...Object.keys(skinbaron.map || {}),
    ...Object.keys(steam.map || {}),
  ]);

  const items = [];
  for (const key of allKeys) {
    const base = caseMap.get(key) || null;
    const detail = details.map[key] || null;
    const market = skinbaron.map[key] || null;
    const steamEntry = steam.map[key] || null;
    const series = timeseries.map[key] || null;

    const name = cleanText(base?.case || detail?.case || market?.case || steamEntry?.name || key);
    const isCase = !!base || !!detail;
    const category = classifyItem(name, isCase);
    const remaining = safeNum(base?.remaining ?? detail?.remaining);
    const dropped = safeNum(base?.dropped ?? detail?.dropped);
    const unboxed = safeNum(base?.unboxed ?? detail?.unboxed);
    const burnRatio = dropped && unboxed != null ? unboxed / dropped : null;
    const skinbaronFloorEur = market?.prices?.[0]?.value ?? null;
    const skinbaronCount = market?.prices?.[0]?.count ?? null;
    const steamPriceEur = steamEntry?.lowestPriceEur ?? steamEntry?.medianPriceEur ?? steamEntry?.latestPriceEur ?? null;
    const steamVolume = steamEntry?.volume ?? steamEntry?.avgVolume30d ?? null;
    const steamDiscountPct = steamPriceEur && skinbaronFloorEur ? ((steamPriceEur - skinbaronFloorEur) / steamPriceEur) * 100 : null;
    const marketUrl = market?.prices?.[0]?.url || null;

    items.push({
      key,
      name,
      isCase,
      category,
      urls: {
        csstonks: detail?.url || null,
        steam: steamEntry?.listingUrl || buildListingUrl(name),
        skinbaron: marketUrl,
      },
      screenshots: detail?.screenshots || { chartUrl: null, pageUrl: null },
      price: {
        skinbaronFloorEur,
        steamPriceEur,
        steamMedianEur: steamEntry?.medianPriceEur ?? null,
        steamVolume,
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
        steamChange7dPct: steamEntry?.change7dPct ?? null,
        steamChange30dPct: steamEntry?.change30dPct ?? null,
        steamChange90dPct: steamEntry?.change90dPct ?? null,
        steamVolatility30dPct: steamEntry?.volatility30dPct ?? null,
        steamDiscountPct,
        skinbaronCount,
        unboxingChange6Pct: series?.change6Pct ?? null,
      },
      charts: {
        steam: steamEntry?.spark || [],
        activity: series?.spark || [],
      },
      sourceCoverage: {
        csstonks: !!detail,
        steam: !!steamEntry,
        skinbaron: !!market,
        timeseries: !!series,
      },
      sources: {
        steamPoints: steamEntry?.historyCount ?? 0,
      },
      scores: {
        total: null,
        entry: null,
        risk: null,
        confidence: null,
        scarcity: null,
        trend: null,
        discount: null,
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

  const minMax = (selector) => {
    const values = items.map(selector).filter((value) => value != null && Number.isFinite(value));
    return values.length ? [Math.min(...values), Math.max(...values)] : [0, 1];
  };

  const [minRemaining, maxRemaining] = minMax((item) => item.metrics.remaining);
  const [minOffers, maxOffers] = minMax((item) => item.metrics.skinbaronCount);
  const [minVolume, maxVolume] = minMax((item) => item.price.steamVolume);

  for (const item of items) {
    const scarcity = item.isCase
      ? scale01(item.metrics.remaining, minRemaining, maxRemaining, true)
      : scale01(item.metrics.skinbaronCount, minOffers, maxOffers, true);
    const burn = item.isCase && item.metrics.burnRatio != null ? clamp01(item.metrics.burnRatio) : null;
    const supplyTrend = item.isCase && item.metrics.momentum12m != null
      ? clamp01((6 - item.metrics.momentum12m) / 12)
      : null;
    const steamTrend = item.metrics.steamChange30dPct == null
      ? null
      : clamp01((item.metrics.steamChange30dPct + 15) / 30);
    const discount = item.metrics.steamDiscountPct == null
      ? null
      : clamp01((item.metrics.steamDiscountPct + 10) / 20);
    const liquidity = scale01(item.price.steamVolume, minVolume, maxVolume, false);
    const stability = item.metrics.steamVolatility30dPct == null
      ? null
      : clamp01(1 - (item.metrics.steamVolatility30dPct / 35));
    const extinction = item.isCase && item.metrics.extinctionMonths != null
      ? item.metrics.extinctionMonths <= 48
        ? 1
        : item.metrics.extinctionMonths <= 96
          ? 0.72
          : 0.35
      : null;
    const confidence = clamp01(
      0.22 +
      (item.sourceCoverage.csstonks ? 0.22 : 0) +
      (item.sourceCoverage.steam ? 0.22 : 0) +
      (item.sourceCoverage.skinbaron ? 0.20 : 0) +
      (item.sourceCoverage.timeseries ? 0.14 : 0)
    );

    const invest = item.isCase
      ? weightedScore([
        { value: scarcity, weight: 0.19 },
        { value: burn, weight: 0.17 },
        { value: supplyTrend, weight: 0.15 },
        { value: steamTrend, weight: 0.14 },
        { value: discount, weight: 0.14 },
        { value: liquidity, weight: 0.09 },
        { value: extinction, weight: 0.06 },
        { value: stability, weight: 0.06 },
      ], 0.46)
      : weightedScore([
        { value: scarcity, weight: 0.22 },
        { value: steamTrend, weight: 0.24 },
        { value: discount, weight: 0.22 },
        { value: liquidity, weight: 0.18 },
        { value: stability, weight: 0.14 },
      ], 0.42);

    const risk = clamp01(
      (0.24 * (scarcity == null ? 0.5 : 1 - scarcity)) +
      (0.18 * (steamTrend == null ? 0.55 : 1 - steamTrend)) +
      (0.17 * (discount == null ? 0.55 : 1 - discount)) +
      (0.14 * (liquidity == null ? 0.55 : 1 - liquidity)) +
      (0.13 * (stability == null ? 0.5 : 1 - stability)) +
      (0.14 * (1 - confidence)) +
      (item.isCase && burn != null ? 0.10 * (1 - burn) : 0)
    );
    const entry = clamp01((0.72 * invest) + (0.18 * confidence) - (0.32 * risk));
    const total = clamp01((0.64 * entry) + (0.18 * confidence) + (0.08 * (discount ?? 0.5)) + (0.10 * (steamTrend ?? 0.5)));

    item.scores.total = total;
    item.scores.entry = entry;
    item.scores.risk = risk;
    item.scores.confidence = confidence;
    item.scores.scarcity = scarcity;
    item.scores.trend = steamTrend ?? supplyTrend;
    item.scores.discount = discount;
    item.scores.liquidity = liquidity;

    const drivers = [
      {
        key: "scarcity",
        label: item.isCase ? "Scarcity" : "Listings",
        score: scarcity,
        value: item.isCase ? item.metrics.remaining : item.metrics.skinbaronCount,
        valueText: item.isCase ? `${(item.metrics.remaining || 0).toLocaleString("en-US")}` : `${(item.metrics.skinbaronCount || 0).toLocaleString("en-US")} offers`,
        note: item.isCase ? "Lower remaining supply lifts the score." : "Fewer SkinBaron listings lift the score.",
      },
      {
        key: "burn",
        label: "Burn ratio",
        score: burn,
        value: item.metrics.burnRatio,
        valueText: burn == null ? "No data" : `${(item.metrics.burnRatio || 0).toFixed(2)}`,
        note: "Higher historical consumption is better.",
      },
      {
        key: "trend",
        label: "Steam trend",
        score: steamTrend,
        value: item.metrics.steamChange30dPct,
        valueText: item.metrics.steamChange30dPct == null ? "No data" : `${item.metrics.steamChange30dPct.toFixed(1)}%`,
        note: "Positive 30d Steam trend supports the entry.",
      },
      {
        key: "discount",
        label: "Steam gap",
        score: discount,
        value: item.metrics.steamDiscountPct,
        valueText: item.metrics.steamDiscountPct == null ? "No data" : `${item.metrics.steamDiscountPct.toFixed(1)}%`,
        note: "External below Steam is favorable.",
      },
      {
        key: "liquidity",
        label: "Liquidity",
        score: liquidity,
        value: item.price.steamVolume,
        valueText: item.price.steamVolume == null ? "No data" : `${Math.round(item.price.steamVolume).toLocaleString("en-US")} volume`,
        note: "Higher Steam volume improves exit quality.",
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

  const sourceTimestamps = [
    toIso(casesRaw?.timestamp),
    details.timestamp,
    skinbaron.timestamp,
    steam.timestamp,
    timeseries.timestamp,
  ].filter(Boolean);
  const updatedAt = sourceTimestamps.sort().slice(-1)[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    updatedAt,
    overview: {
      totalItems: items.length,
      totalCases: items.filter((item) => item.isCase).length,
      marketOnlyCount: items.filter((item) => !item.isCase).length,
      goodCount: items.filter((item) => item.grade.label === "GOOD").length,
      warnCount: items.filter((item) => item.grade.label === "WARN").length,
      badCount: items.filter((item) => item.grade.label === "BAD").length,
      topCandidate: items[0] ? compactItem(items[0]) : null,
      bestDiscount: [...items].sort((a, b) => (b.metrics.steamDiscountPct ?? -999) - (a.metrics.steamDiscountPct ?? -999))[0]
        ? compactItem([...items].sort((a, b) => (b.metrics.steamDiscountPct ?? -999) - (a.metrics.steamDiscountPct ?? -999))[0])
        : null,
      strongestSteamTrend: [...items].sort((a, b) => (b.metrics.steamChange30dPct ?? -999) - (a.metrics.steamChange30dPct ?? -999))[0]
        ? compactItem([...items].sort((a, b) => (b.metrics.steamChange30dPct ?? -999) - (a.metrics.steamChange30dPct ?? -999))[0])
        : null,
    },
    diagnostics: [
      !steam.timestamp ? "Steam summary cache is missing, so only SkinBaron and CSStonks signals are available." : null,
      !skinbaron.timestamp ? "SkinBaron pricing is missing, so the full container universe is incomplete." : null,
      timeseries.failures.length ? `CSStonks timeseries still fails for ${timeseries.failures.length} case(s).` : null,
    ].filter(Boolean),
    sources: {
      cases: { label: "Cases", ...fileInfo(root, paths.cases), timestamp: toIso(casesRaw?.timestamp) },
      details: { label: "Case details", ...fileInfo(root, paths.details), timestamp: details.timestamp },
      skinbaron: { label: "SkinBaron", ...fileInfo(root, paths.pricempire), timestamp: skinbaron.timestamp, matched: Object.keys(skinbaron.map).length },
      steam: { label: "Steam cache", ...fileInfo(root, paths.steam || "steam_market_data.json"), timestamp: steam.timestamp, matched: Object.keys(steam.map).length },
      timeseries: { label: "CSStonks timeseries", ...fileInfo(root, paths.timeseries), timestamp: timeseries.timestamp, failures: timeseries.failures.length },
      shots: { label: "Screenshots", path: paths.shotsDir, exists: fs.existsSync(path.resolve(root, paths.shotsDir)) },
    },
    refreshHealth: {
      hasSteam: !!steam.timestamp,
      hasSkinbaron: !!skinbaron.timestamp,
      totalTracked: items.length,
      caseCoverage: items.filter((item) => item.isCase && item.sourceCoverage.csstonks).length,
      steamCoverage: items.filter((item) => item.sourceCoverage.steam).length,
    },
    items,
    refresh: extra.refresh || null,
  };
}

module.exports = {
  buildDashboard,
  normalizeName,
};
