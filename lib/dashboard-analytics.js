const fs = require("fs");
const path = require("path");

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNum(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function cleanText(value) {
  return String(value || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeProviderKey(value) {
  return String(value || "").trim().toLowerCase();
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toWebPath(relativePath) {
  const bits = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent);
  return bits.length ? `/${bits.join("/")}` : null;
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
  let missing = 0;

  for (const part of parts) {
    if (part.value == null || !Number.isFinite(part.value)) {
      missing += part.weight;
      continue;
    }
    weighted += part.value * part.weight;
    weights += part.weight;
  }

  if (!weights) {
    return { score: fallback, missingWeight: 1 };
  }

  return {
    score: clamp01(weighted / weights),
    missingWeight: clamp01(missing),
  };
}

function describeMomentum(raw) {
  if (raw == null) {
    return { label: "Unknown", tone: "warn" };
  }
  if (raw <= -3) return { label: `Shrinking ${Math.abs(raw).toFixed(2)}%`, tone: "good" };
  if (raw < 0) return { label: `Slight shrink ${Math.abs(raw).toFixed(2)}%`, tone: "good" };
  if (raw < 2) return { label: `Flat / stable ${raw.toFixed(2)}%`, tone: "warn" };
  return { label: `Expanding ${raw.toFixed(2)}%`, tone: "bad" };
}

function describeRisk(value) {
  if (value == null) return { label: "Unknown", tone: "warn" };
  if (value <= 0.38) return { label: "Low", tone: "good" };
  if (value <= 0.68) return { label: "Medium", tone: "warn" };
  return { label: "High", tone: "bad" };
}

function caseUrl(name) {
  return `https://csstonks.com/case/${encodeURIComponent(name)}`;
}

function extractDetails(raw, shotsDir) {
  const records = [];

  if (Array.isArray(raw?.cases)) {
    records.push(...raw.cases);
  } else if (raw && raw.map && typeof raw.map === "object") {
    for (const [name, value] of Object.entries(raw.map)) {
      records.push({ case: name, ...value });
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      if (["timestamp", "source", "meta"].includes(name)) continue;
      records.push({ case: value.case || name, ...value });
    }
  }

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
      url: record.url || caseUrl(name),
      remaining: safeNum(record.remaining ?? record.totals?.remaining ?? record.currentRemainingSupply ?? pageCards.currentRemainingSupply),
      dropped: safeNum(record.dropped ?? record.totals?.dropped),
      unboxed: safeNum(record.unboxed ?? record.totals?.unboxed),
      price: safeNum(record.price ?? record.totals?.price ?? pageCards.priceUSD),
      marketCap: safeNum(record.marketCap ?? record.totals?.marketCap ?? pageCards.marketCapUSD),
      delta1m: safeNum(record.delta1m ?? pageCards.delta1m?.percent ?? pageCards.delta1m),
      delta6m: safeNum(record.delta6m ?? pageCards.delta6m?.percent ?? pageCards.delta6m),
      delta12m: safeNum(record.delta12m ?? pageCards.delta12m?.percent ?? pageCards.delta12m),
      extinctionMonths: safeNum(record.extinctionMonths ?? record.extMonths ?? extinction.months),
      extinctionDate: record.extinctionDate || record.extDate || extinction.approxDate || null,
      screenshots: {
        chartUrl: chartName ? toWebPath(path.join(shotsDir, chartName)) : null,
        pageUrl: pageName ? toWebPath(path.join(shotsDir, pageName)) : null,
        mode: screenshots.mode || null,
      },
    };
  }

  return {
    timestamp: toIso(raw?.timestamp),
    source: raw?.source || null,
    map,
  };
}

function extractPriceMap(raw) {
  const base = raw?.map && typeof raw.map === "object" ? raw.map : raw;
  const map = {};

  if (base && typeof base === "object") {
    for (const [key, value] of Object.entries(base)) {
      const numeric = safeNum(value);
      if (numeric == null) continue;
      map[normalizeName(key)] = numeric;
    }
  }

  return {
    timestamp: toIso(raw?.meta?.timestamp || raw?.timestamp),
    provider: raw?.meta?.provider || raw?.provider || null,
    currency: raw?.meta?.currency || raw?.currency || "EUR",
    scraped: safeNum(raw?.meta?.scraped) ?? Object.keys(map).length,
    errors: Array.isArray(raw?.errors) ? raw.errors : [],
    map,
  };
}

function extractMarketplaceCollection(raw) {
  const providersRaw = raw?.providers && typeof raw.providers === "object" ? raw.providers : {};
  const providers = {};

  for (const [key, value] of Object.entries(providersRaw)) {
    const providerKey = normalizeProviderKey(key || value?.key);
    if (!providerKey) continue;
    providers[providerKey] = {
      key: providerKey,
      name: cleanText(value?.name || providerKey) || providerKey,
      logo: value?.logo || null,
      country: value?.country || null,
      type: value?.type || null,
    };
  }

  const base = raw?.map && typeof raw.map === "object" ? raw.map : {};
  const map = {};

  for (const [caseName, entries] of Object.entries(base)) {
    if (!Array.isArray(entries)) continue;

    const deduped = new Map();
    for (const entry of entries) {
      const providerKey = normalizeProviderKey(entry?.providerKey || entry?.provider_key || entry?.key);
      const value = safeNum(entry?.value ?? entry?.price);
      if (!providerKey || value == null || value <= 0) continue;

      const provider = providers[providerKey] || null;
      const next = {
        providerKey,
        providerName: cleanText(entry?.providerName || entry?.provider_name || provider?.name || providerKey) || providerKey,
        value,
        count: safeNum(entry?.count),
        updatedAt: toIso(entry?.updatedAt || entry?.updated_at),
        lastCheckedAt: toIso(entry?.lastCheckedAt || entry?.last_checked_at),
        sourceCurrency: cleanText(entry?.sourceCurrency || entry?.source_currency || raw?.meta?.currency || raw?.currency || "EUR") || "EUR",
      };

      const current = deduped.get(providerKey);
      if (!current || next.value < current.value) {
        deduped.set(providerKey, next);
      }
    }

    const prices = [...deduped.values()].sort((left, right) => {
      if (left.value !== right.value) return left.value - right.value;
      return left.providerName.localeCompare(right.providerName);
    });

    if (prices.length) {
      map[normalizeName(caseName)] = {
        case: caseName,
        prices,
      };
    }
  }

  return {
    timestamp: toIso(raw?.meta?.timestamp || raw?.timestamp),
    source: raw?.meta?.source || raw?.source || null,
    currency: cleanText(raw?.meta?.currency || raw?.currency || "EUR") || "EUR",
    scraped: safeNum(raw?.meta?.scraped) ?? Object.keys(map).length,
    providerCount: safeNum(raw?.meta?.providers) ?? Object.keys(providers).length,
    errors: Array.isArray(raw?.errors) ? raw.errors : [],
    providers,
    map,
  };
}

function buildLegacyMarketplaceFallback(csmoney, csfloat) {
  const map = {};
  const ensureCase = (caseKey, caseName) => {
    if (!map[caseKey]) {
      map[caseKey] = {
        case: caseName,
        prices: [],
      };
    }
    return map[caseKey];
  };

  for (const [caseKey, value] of Object.entries(csmoney.map || {})) {
    const record = ensureCase(caseKey, caseKey);
    record.prices.push({
      providerKey: "csmoneym",
      providerName: "CS.MONEY",
      value,
      count: null,
      updatedAt: csmoney.timestamp,
      lastCheckedAt: csmoney.timestamp,
      sourceCurrency: csmoney.currency || "EUR",
    });
  }

  for (const [caseKey, value] of Object.entries(csfloat.map || {})) {
    const record = ensureCase(caseKey, caseKey);
    record.prices.push({
      providerKey: "csfloat",
      providerName: "CSFloat",
      value,
      count: null,
      updatedAt: csfloat.timestamp,
      lastCheckedAt: csfloat.timestamp,
      sourceCurrency: csfloat.currency || "EUR",
    });
  }

  for (const record of Object.values(map)) {
    record.prices.sort((left, right) => left.value - right.value);
  }

  return {
    timestamp: csmoney.timestamp || csfloat.timestamp || null,
    source: "legacy provider files",
    currency: "EUR",
    scraped: Object.keys(map).length,
    providerCount: ["csmoneym", "csfloat"].filter((providerKey) =>
      Object.values(map).some((record) => record.prices.some((price) => price.providerKey === providerKey))
    ).length,
    errors: [...(csmoney.errors || []), ...(csfloat.errors || [])],
    providers: {
      csmoneym: { key: "csmoneym", name: "CS.MONEY", logo: null, country: null, type: null },
      csfloat: { key: "csfloat", name: "CSFloat", logo: null, country: null, type: null },
    },
    map,
  };
}

function pickProviderPriceByKeys(prices, providerKeys) {
  if (!Array.isArray(prices) || !Array.isArray(providerKeys)) return null;
  for (const providerKey of providerKeys) {
    const match = prices.find((entry) => entry.providerKey === providerKey);
    if (match) return match.value;
  }
  return null;
}

function buildDashboard(root, config, extra = {}) {
  const paths = config.paths;
  const casesPath = path.resolve(root, paths.cases);
  const detailsPath = path.resolve(root, paths.details);
  const pricempirePath = path.resolve(root, paths.pricempire || "pricempire_prices_eur.json");
  const csmPath = path.resolve(root, paths.csmoney);
  const csfPath = path.resolve(root, paths.csfloat);
  const timeseriesPath = path.resolve(root, paths.timeseries);

  const casesRaw = readJson(casesPath) || { cases: [] };
  const details = extractDetails(readJson(detailsPath), paths.shotsDir);
  const pricempire = extractMarketplaceCollection(readJson(pricempirePath));
  const csmoney = extractPriceMap(readJson(csmPath));
  const csfloat = extractPriceMap(readJson(csfPath));
  const timeseriesRaw = readJson(timeseriesPath);
  const legacyMarketplaces = buildLegacyMarketplaceFallback(csmoney, csfloat);
  const externalMarkets = Object.keys(pricempire.map).length ? pricempire : legacyMarketplaces;

  const universe = Array.isArray(casesRaw.cases) ? casesRaw.cases : [];
  const normalizedUniverseKeys = new Set(universe.map((item) => normalizeName(item.case)));

  const detailMap = details.map;
  const marketMap = {};

  for (const [key, value] of Object.entries(externalMarkets.map || {})) {
    if (normalizedUniverseKeys.has(key)) marketMap[key] = value;
  }

  const marketCovered = Object.values(marketMap).filter((record) => Array.isArray(record?.prices) && record.prices.length > 0).length;
  const csmCovered = Object.values(marketMap).filter((record) =>
    Array.isArray(record?.prices) && record.prices.some((price) => price.providerKey === "csmoneym" || price.providerKey === "csmoney")
  ).length;
  const csfCovered = Object.values(marketMap).filter((record) =>
    Array.isArray(record?.prices) && record.prices.some((price) => price.providerKey === "csfloat")
  ).length;
  const universeCount = normalizedUniverseKeys.size;
  const missingPricingProviders = [];
  if (marketCovered === 0) missingPricingProviders.push("PriceEmpire marketplaces");
  const pricingIncomplete = missingPricingProviders.length > 0;

  const list = universe.map((base) => {
    const key = normalizeName(base.case);
    const detail = detailMap[key] || null;
    const remaining = safeNum(base.remaining ?? detail?.remaining);
    const dropped = safeNum(base.dropped ?? detail?.dropped);
    const unboxed = safeNum(base.unboxed ?? detail?.unboxed);
    const steamPriceUsd = safeNum(base.price ?? detail?.price);
    const marketCapUsd = safeNum(base.marketCap ?? detail?.marketCap);
    const burnRatio = dropped && dropped > 0 && unboxed != null ? clamp01(unboxed / dropped) : null;
    const momentum1m = safeNum(detail?.delta1m);
    const momentum6m = safeNum(detail?.delta6m);
    const momentum12m = safeNum(detail?.delta12m);
    const momentumRaw = momentum1m ?? momentum6m ?? momentum12m ?? null;
    const extinctionMonths = safeNum(detail?.extinctionMonths);
    const marketplacePrices = marketMap[key]?.prices || [];
    const csmoneyEur = pickProviderPriceByKeys(marketplacePrices, ["csmoneym", "csmoney"]);
    const csfloatEur = pickProviderPriceByKeys(marketplacePrices, ["csfloat"]);
    const externalPrices = marketplacePrices.map((entry) => entry.value).filter((value) => value != null);
    const externalFloorEur = externalPrices.length ? Math.min(...externalPrices) : null;
    const externalCeilingEur = externalPrices.length ? Math.max(...externalPrices) : null;
    const externalSpreadPct =
      externalPrices.length >= 2
        ? safeNum((Math.abs(externalCeilingEur - externalFloorEur) / ((externalCeilingEur + externalFloorEur) / 2)) * 100)
        : null;

    return {
      case: base.case,
      key,
      url: detail?.url || caseUrl(base.case),
      metrics: {
        remaining,
        dropped,
        unboxed,
        steamPriceUsd,
        marketCapUsd,
        burnRatio,
        momentum1m,
        momentum6m,
        momentum12m,
        momentumRaw,
        extinctionMonths,
        extinctionDate: detail?.extinctionDate || null,
        csmoneyEur,
        csfloatEur,
        marketplacesTracked: marketplacePrices.length,
        externalFloorEur,
        externalCeilingEur,
        externalSpreadPct,
        lifetimeRatio: remaining != null && unboxed ? remaining / unboxed : null,
      },
      marketplaces: {
        prices: marketplacePrices,
      },
      sourceCoverage: {
        details: !!detail,
        marketplaces: marketplacePrices.length > 0,
        marketCount: marketplacePrices.length,
        csmoney: csmoneyEur != null,
        csfloat: csfloatEur != null,
        chart: !!detail?.screenshots?.chartUrl,
      },
      screenshots: detail?.screenshots || { chartUrl: null, pageUrl: null, mode: null },
      scores: {
        scarcity: null,
        liquidity: null,
        momentum: null,
        value: null,
        buyNow: null,
        risk: null,
        edge: null,
        scoreBase: null,
        dataQuality: null,
        marketplaceConfidence: null,
        extinctionCatalyst: null,
        conviction: null,
      },
      grade: {
        label: "WARN",
        tone: "warn",
        reason: "Mixed signals",
      },
      thesis: [],
      risks: [],
      tags: [],
    };
  });

  const finite = (selector) => list.map(selector).filter((value) => value != null && Number.isFinite(value));
  const minMax = (selector) => {
    const values = finite(selector);
    return values.length ? [Math.min(...values), Math.max(...values)] : [0, 1];
  };

  const [minRemaining, maxRemaining] = minMax((item) => item.metrics.remaining);
  const [minMarketCap, maxMarketCap] = minMax((item) => item.metrics.marketCapUsd);
  const [minSteamPrice, maxSteamPrice] = minMax((item) => item.metrics.steamPriceUsd);
  const [minLifetime, maxLifetime] = minMax((item) => item.metrics.lifetimeRatio);

  for (const item of list) {
    const scarcity = scale01(item.metrics.remaining, minRemaining, maxRemaining, true);
    const liquidity = scale01(item.metrics.marketCapUsd, minMarketCap, maxMarketCap, false);
    const lifetimeScore = scale01(item.metrics.lifetimeRatio, minLifetime, maxLifetime, true);
    const burnScore = item.metrics.burnRatio == null ? null : clamp01(item.metrics.burnRatio);
    const momentumScore = item.metrics.momentumRaw == null ? 0.5 : clamp01((4 - item.metrics.momentumRaw) / 8);
    const expansionRisk = item.metrics.momentumRaw == null ? 0.18 : clamp01((item.metrics.momentumRaw + 1) / 6);
    const extinctionCatalyst =
      item.metrics.extinctionMonths == null
        ? 0.5
        : item.metrics.extinctionMonths <= 24
          ? 1
          : item.metrics.extinctionMonths <= 72
            ? 0.78
            : item.metrics.extinctionMonths <= 180
              ? 0.48
              : 0.24;
    const priceScaled = scale01(item.metrics.steamPriceUsd, minSteamPrice, maxSteamPrice, false);
    const externalCount = item.marketplaces.prices.length;
    const spreadConfidence =
      item.metrics.externalSpreadPct == null
        ? externalCount >= 2
          ? 0.72
          : externalCount === 1
            ? 0.58
            : 0.38
        : clamp01(1 - item.metrics.externalSpreadPct / 24);
    const coverageLift = externalCount <= 1 ? 0 : Math.min(0.18, (externalCount - 1) * 0.04);
    const marketplaceConfidence = clamp01(spreadConfidence + coverageLift);

    const valueScore =
      scarcity == null && priceScaled == null
        ? 0.5
        : clamp01((0.62 * (scarcity ?? 0.5)) + (0.24 * (priceScaled == null ? 0.5 : 1 - priceScaled)) + (0.14 * (burnScore ?? 0.5)));

    const coreMissing = [
      item.metrics.remaining,
      item.metrics.dropped,
      item.metrics.unboxed,
      item.metrics.steamPriceUsd,
      item.metrics.marketCapUsd,
    ].filter((value) => value == null).length;
    const momentumMissing = item.metrics.momentumRaw == null ? 1 : 0;
    const extinctionMissing = item.metrics.extinctionMonths == null ? 1 : 0;
    const screenshotMissing = item.screenshots.chartUrl ? 0 : 1;
    const externalMissing = Math.max(0, 3 - Math.min(3, externalCount));

    const dataQuality = clamp01(
      1 - (0.11 * coreMissing) - (0.08 * momentumMissing) - (0.05 * extinctionMissing) - (0.04 * externalMissing) - (0.03 * screenshotMissing)
    );

    const baseScore = weightedScore(
      [
        { value: scarcity, weight: 0.34 },
        { value: burnScore, weight: 0.24 },
        { value: momentumScore, weight: 0.18 },
        { value: lifetimeScore, weight: 0.12 },
        { value: liquidity, weight: 0.12 },
      ],
      0.5
    );

    const riskScore = clamp01(
      (0.28 * (liquidity == null ? 0.5 : 1 - liquidity)) +
      (0.24 * (burnScore == null ? 0.42 : 1 - burnScore)) +
      (0.22 * expansionRisk) +
      (0.16 * clamp01((coreMissing / 5) * 0.8 + (momentumMissing * 0.12) + ((externalMissing / 3) * 0.08))) +
      (0.10 * (item.metrics.extinctionMonths == null ? 0.2 : item.metrics.extinctionMonths > 240 ? 0.36 : item.metrics.extinctionMonths < 18 ? 0.16 : 0.06)) +
      ((item.metrics.steamPriceUsd != null && item.metrics.steamPriceUsd > 12 && (burnScore ?? 0.5) < 0.55) ? 0.08 : 0)
    );

    const buyScore = weightedScore(
      [
        { value: scarcity, weight: 0.32 },
        { value: burnScore, weight: 0.22 },
        { value: momentumScore, weight: 0.16 },
        { value: liquidity, weight: 0.12 },
        { value: extinctionCatalyst, weight: 0.10 },
        { value: marketplaceConfidence, weight: 0.08 },
      ],
      0.5
    );

    const buyNow = clamp01(buyScore.score - (0.16 * riskScore) - (0.16 * buyScore.missingWeight));
    const edge = clamp01(
      (0.56 * buyNow) +
      (0.14 * valueScore) +
      (0.10 * (liquidity ?? 0.5)) +
      (0.12 * dataQuality) +
      (0.08 * marketplaceConfidence) -
      (0.48 * riskScore)
    );
    const conviction = clamp01((0.48 * dataQuality) + (0.24 * marketplaceConfidence) + (0.28 * (1 - riskScore)));

    item.scores.scarcity = scarcity;
    item.scores.liquidity = liquidity;
    item.scores.momentum = momentumScore;
    item.scores.value = valueScore;
    item.scores.buyNow = buyNow;
    item.scores.risk = riskScore;
    item.scores.edge = edge;
    item.scores.scoreBase = baseScore.score;
    item.scores.dataQuality = dataQuality;
    item.scores.marketplaceConfidence = marketplaceConfidence;
    item.scores.extinctionCatalyst = extinctionCatalyst;
    item.scores.conviction = conviction;
  }

  const strictness = clamp01((safeNum(config.analysis?.strictness) ?? 55) / 100);
  const goodThreshold = percentile(list.map((item) => item.scores.edge), 0.58 + (0.24 * strictness));
  const badThreshold = percentile(list.map((item) => item.scores.edge), 0.42 - (0.24 * strictness));

  for (const item of list) {
    if (goodThreshold != null && item.scores.edge >= goodThreshold) {
      item.grade.label = "GOOD";
      item.grade.tone = "good";
    } else if (badThreshold != null && item.scores.edge <= badThreshold) {
      item.grade.label = "BAD";
      item.grade.tone = "bad";
    } else {
      item.grade.label = "WARN";
      item.grade.tone = "warn";
    }

    if ((item.scores.dataQuality ?? 0.5) < 0.35 && item.grade.label === "GOOD") {
      item.grade.label = "WARN";
      item.grade.tone = "warn";
    }

    const reasons = [];
    if ((item.scores.buyNow ?? 0) >= 0.62) reasons.push("strong entry");
    if ((item.scores.buyNow ?? 0) <= 0.40) reasons.push("weak entry");
    if ((item.scores.risk ?? 0.5) <= 0.40) reasons.push("low risk");
    if ((item.scores.risk ?? 0.5) >= 0.70) reasons.push("high risk");
    if ((item.scores.scarcity ?? 0.5) >= 0.66) reasons.push("scarce");
    if ((item.metrics.burnRatio ?? 0.5) >= 0.65) reasons.push("high burn");
    if ((item.metrics.burnRatio ?? 0.5) <= 0.45) reasons.push("weak burn");
    if ((item.scores.dataQuality ?? 0.5) < 0.45) reasons.push("low confidence");
    item.grade.reason = reasons.slice(0, 3).join(" • ") || "mixed signals";

    if ((item.scores.scarcity ?? 0) >= 0.70) item.tags.push("Scarcity");
    if ((item.scores.value ?? 0) >= 0.62) item.tags.push("Value");
    if ((item.scores.risk ?? 1) <= 0.38) item.tags.push("Low risk");
    if ((item.metrics.marketCapUsd ?? 0) >= 100_000_000) item.tags.push("Liquid");
    if ((item.metrics.momentumRaw ?? 0) <= -2) item.tags.push("Supply shrinking");
    if ((item.metrics.momentumRaw ?? 0) >= 2) item.tags.push("Supply expanding");
    if (item.marketplaces.prices.length >= 6) item.tags.push("Broad pricing");

    if ((item.scores.scarcity ?? 0) >= 0.66) {
      item.thesis.push("Remaining supply is low versus the tracked universe, which improves scarcity leverage.");
    }
    if ((item.metrics.burnRatio ?? 0) >= 0.64) {
      item.thesis.push("Burn ratio is strong, so the minted supply has been consumed aggressively.");
    }
    if ((item.metrics.momentumRaw ?? 99) <= -2) {
      item.thesis.push("Recent momentum still points to shrinking supply, which supports the scarcity story.");
    }
    if (item.metrics.extinctionMonths != null && item.metrics.extinctionMonths <= 72) {
      item.thesis.push(`Projected scarcity catalyst sits around ${item.metrics.extinctionMonths.toFixed(1)} months.`);
    }
    if (item.marketplaces.prices.length >= 4) {
      item.thesis.push(`${item.marketplaces.prices.length} PriceEmpire marketplaces are available, which improves external price confirmation.`);
    }
    if (item.metrics.externalSpreadPct != null && item.metrics.externalSpreadPct <= 6) {
      item.thesis.push("External marketplace quotes are tightly aligned, which adds confidence to the price read.");
    }
    if (!item.thesis.length) {
      item.thesis.push("The setup is usable, but the edge depends more on portfolio fit than on one standout signal.");
    }

    if ((item.scores.risk ?? 0) >= 0.70) {
      item.risks.push("Risk score is high, so position sizing should stay conservative.");
    }
    if ((item.metrics.momentumRaw ?? -99) >= 2) {
      item.risks.push("Supply is still expanding, which can cap upside until the trend turns.");
    }
    if ((item.metrics.burnRatio ?? 1) <= 0.45) {
      item.risks.push("Burn ratio is weak, so scarcity is not tightening quickly enough yet.");
    }
    if ((item.scores.dataQuality ?? 1) < 0.5) {
      item.risks.push("Data quality is light, so the score should be treated as a lower-confidence signal.");
    }
    if (item.marketplaces.prices.length <= 1) {
      item.risks.push("There is little marketplace confirmation for this case, so cross-checking prices matters before entry.");
    }
    if (item.metrics.extinctionMonths == null) {
      item.risks.push("No extinction projection is available for this case in the current dataset.");
    }
    if (item.metrics.externalSpreadPct != null && item.metrics.externalSpreadPct >= 12) {
      item.risks.push("Marketplace prices disagree materially, so cross-market validation matters before entry.");
    }
    if (!item.risks.length) {
      item.risks.push("Main risk is execution timing rather than an obvious red flag in the current snapshot.");
    }

    item.market = {
      momentum: describeMomentum(item.metrics.momentumRaw),
      risk: describeRisk(item.scores.risk),
    };
  }

  list.sort((a, b) => (b.scores.edge ?? 0) - (a.scores.edge ?? 0));
  list.forEach((item, index) => {
    item.rank = index + 1;
  });

  const goodCount = list.filter((item) => item.grade.label === "GOOD").length;
  const warnCount = list.filter((item) => item.grade.label === "WARN").length;
  const badCount = list.filter((item) => item.grade.label === "BAD").length;
  const shrinkingCount = list.filter((item) => (item.metrics.momentumRaw ?? 0) < 0).length;
  const expandingCount = list.filter((item) => (item.metrics.momentumRaw ?? 0) > 0).length;
  const duplicateMomentumCount = list.filter((item) => {
    const { momentum1m, momentum6m, momentum12m } = item.metrics;
    return momentum1m != null && momentum1m === momentum6m && momentum6m === momentum12m;
  }).length;

  const sourceTimestamps = [
    toIso(casesRaw?.timestamp),
    details.timestamp,
    externalMarkets.timestamp,
    fileInfo(root, paths.cases).updatedAt,
    fileInfo(root, paths.details).updatedAt,
    fileInfo(root, paths.pricempire || "pricempire_prices_eur.json").updatedAt,
  ].filter(Boolean);

  const updatedAt = sourceTimestamps.sort().slice(-1)[0] || null;

  const median = (selector) => {
    const values = list.map(selector).filter((value) => value != null && Number.isFinite(value)).sort((a, b) => a - b);
    if (!values.length) return null;
    return values[Math.floor(values.length / 2)];
  };

  const by = (selector, direction = "desc") => {
    const sorted = [...list].sort((left, right) => {
      const a = selector(left) ?? (direction === "desc" ? -Infinity : Infinity);
      const b = selector(right) ?? (direction === "desc" ? -Infinity : Infinity);
      return direction === "desc" ? b - a : a - b;
    });
    return sorted.slice(0, 5).map(toCompactCase);
  };

  const diagnostics = [];
  if (!list.length) diagnostics.push("No case universe is available yet. Run a refresh to populate the dashboard.");
  if (!details.timestamp) diagnostics.push("`case_details.json` is missing or unreadable, so momentum and extinction coverage are limited.");
  if (!pricempire.timestamp && legacyMarketplaces.timestamp) {
    diagnostics.push("Using legacy CS.MONEY / CSFloat pricing fallback because the combined PriceEmpire marketplace file is missing.");
  }
  if (!externalMarkets.timestamp) diagnostics.push("PriceEmpire marketplace pricing is missing, so external market confirmation is unavailable.");
  if (externalMarkets.timestamp && marketCovered === 0) diagnostics.push("PriceEmpire marketplace pricing exists, but it contains zero matched prices for the current case universe.");
  if (duplicateMomentumCount && duplicateMomentumCount / Math.max(1, list.length) >= 0.5) {
    diagnostics.push("Many cases have identical 1m / 6m / 12m momentum values. Review the detail scraper before trusting time-window comparisons.");
  }
  if (timeseriesRaw?.failures?.length) {
    diagnostics.push(`Timeseries scrape is currently failing for ${timeseriesRaw.failures.length} cases.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    updatedAt,
    overview: {
      totalCases: list.length,
      goodCount,
      warnCount,
      badCount,
      shrinkingCount,
      expandingCount,
      medianBurn: median((item) => item.metrics.burnRatio),
      medianMarketCapUsd: median((item) => item.metrics.marketCapUsd),
      topCandidate: list[0] ? toCompactCase(list[0]) : null,
      mood:
        shrinkingCount > expandingCount
          ? "More tracked cases are still shrinking in supply than expanding."
          : expandingCount > shrinkingCount
            ? "Supply expansion is dominating the current snapshot, so patience matters."
            : "Supply momentum is fairly mixed across the current universe.",
    },
    highlights: {
      topBuy: by((item) => item.scores.edge),
      bestValue: by((item) => item.scores.value),
      lowRisk: by((item) => item.scores.risk == null ? null : 1 - item.scores.risk),
      scarce: by((item) => item.scores.scarcity),
      liquid: by((item) => item.metrics.marketCapUsd),
    },
    sources: {
      cases: {
        ...fileInfo(root, paths.cases),
        timestamp: toIso(casesRaw?.timestamp),
      },
      details: {
        ...fileInfo(root, paths.details),
        timestamp: details.timestamp,
      },
      pricempire: {
        ...fileInfo(root, paths.pricempire || "pricempire_prices_eur.json"),
        timestamp: externalMarkets.timestamp,
        scraped: externalMarkets.scraped,
        matched: marketCovered,
        providers: externalMarkets.providerCount,
        errors: externalMarkets.errors.length,
        fallback: !pricempire.timestamp && !!legacyMarketplaces.timestamp,
      },
      timeseries: {
        ...fileInfo(root, paths.timeseries),
        timestamp: toIso(timeseriesRaw?.generatedAt),
        failures: Array.isArray(timeseriesRaw?.failures) ? timeseriesRaw.failures.length : 0,
      },
      shots: {
        path: paths.shotsDir,
        exists: fs.existsSync(path.resolve(root, paths.shotsDir)),
      },
    },
    refreshHealth: {
      pricingIncomplete,
      missingPricingProviders,
      universeCount,
      pricingCoverage: {
        pricempire: marketCovered,
        providers: externalMarkets.providerCount,
        csmoney: csmCovered,
        csfloat: csfCovered,
      },
    },
    diagnostics,
    cases: list,
    refresh: extra.refresh || null,
  };
}

function toCompactCase(item) {
  return {
    case: item.case,
    rank: item.rank,
    grade: item.grade,
    edge: item.scores.edge,
    buyNow: item.scores.buyNow,
    risk: item.scores.risk,
    value: item.scores.value,
    scarcity: item.scores.scarcity,
    burnRatio: item.metrics.burnRatio,
    marketCapUsd: item.metrics.marketCapUsd,
    remaining: item.metrics.remaining,
    url: item.url,
  };
}

module.exports = {
  buildDashboard,
  normalizeName,
};
