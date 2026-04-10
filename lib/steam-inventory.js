const https = require("https");
const { URL } = require("url");
const zlib = require("zlib");
const { fetchSteamMarket, fetchSteamOverview } = require("./steam-market");
const { normalizeName } = require("./dashboard-analytics-v2");

function safeNum(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function previewText(value, maxLength = 400) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
          accept: "application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "gzip, deflate, br",
          referer: "https://steamcommunity.com/",
          origin: "https://steamcommunity.com",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
          let decoded = buffer;
          try {
            if (encoding.includes("gzip")) {
              decoded = zlib.gunzipSync(buffer);
            } else if (encoding.includes("deflate")) {
              decoded = zlib.inflateSync(buffer);
            } else if (encoding.includes("br")) {
              decoded = zlib.brotliDecompressSync(buffer);
            }
          } catch {
            decoded = buffer;
          }

          const body = decoded.toString("utf8");
          let payload = null;
          try {
            payload = JSON.parse(body || "{}");
          } catch {
            payload = null;
          }
          resolve({
            statusCode: response.statusCode || 0,
            url,
            body,
            payload,
            headers: response.headers || {},
          });
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`Request timed out for ${url}`));
    });
    request.end();
  });
}

function pushAttempt(debug, stage, response) {
  if (!debug || !Array.isArray(debug.attempts)) return;
  debug.attempts.push({
    stage,
    url: response?.url || null,
    statusCode: response?.statusCode || 0,
    payloadKeys:
      response?.payload && typeof response.payload === "object"
        ? Object.keys(response.payload).slice(0, 20)
        : [],
    bodyPreview: previewText(response?.body || ""),
  });
}

function attachDebug(error, debug) {
  if (error && debug) {
    error.debug = {
      fetchedAt: new Date().toISOString(),
      ...debug,
    };
  }
  return error;
}

async function fetchLegacySteamInventory(steamId, appId, contextId, language, debug) {
  const url = new URL(`https://steamcommunity.com/profiles/${steamId}/inventory/json/${appId}/${contextId}/`);
  url.searchParams.set("l", language);
  url.searchParams.set("trading", "1");

  const response = await requestJson(url.toString());
  const payload = response.payload;
  pushAttempt(debug, "legacy", response);

  if (response.statusCode === 400 || response.statusCode === 403) {
    const message = payload?.Error || payload?.error || "Steam inventory is private or not accessible.";
    const error = new Error(message);
    error.code = "STEAM_INVENTORY_PRIVATE";
    throw attachDebug(error, debug);
  }

  if (response.statusCode !== 200 || !payload || payload.success !== true) {
    const message = payload?.Error || payload?.error || `Steam legacy inventory fetch failed (${response.statusCode}).`;
    const error = new Error(message);
    error.code = "STEAM_INVENTORY_FETCH_FAILED";
    throw attachDebug(error, debug);
  }

  const assets = [];
  const descriptions = new Map();

  for (const asset of Object.values(payload.rgInventory || {})) {
    assets.push(asset);
  }

  for (const description of Object.values(payload.rgDescriptions || {})) {
    descriptions.set(`${description.classid}_${description.instanceid}`, description);
  }

  return { assets, descriptions, debug };
}

async function fetchSteamInventory(steamId, options = {}) {
  const appId = options.appId || 730;
  const contextId = options.contextId || 2;
  const language = options.language || "english";
  const pageSize = Math.max(1, Math.min(2000, Number(options.count) || 2000));
  const debug = {
    steamId,
    appId,
    contextId,
    language,
    pageSize,
    attempts: [],
  };

  let more = true;
  let startAssetId = null;
  const assets = [];
  const descriptions = new Map();

  while (more) {
    const url = new URL(`https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}`);
    url.searchParams.set("l", language);
    url.searchParams.set("count", String(pageSize));
    if (startAssetId) url.searchParams.set("start_assetid", startAssetId);

    const response = await requestJson(url.toString());
    const payload = response.payload;
    pushAttempt(debug, "modern", response);

    if (response.statusCode === 400) {
      return fetchLegacySteamInventory(steamId, appId, contextId, language, debug);
    }

    if (response.statusCode === 403) {
      const error = new Error(payload?.Error || payload?.error || "Steam inventory is private or not accessible.");
      error.code = "STEAM_INVENTORY_PRIVATE";
      throw attachDebug(error, debug);
    }

    if (response.statusCode !== 200 || !payload || payload.success !== 1) {
      const message = payload?.Error || `Steam inventory fetch failed (${response.statusCode}).`;
      const error = new Error(message);
      error.code = payload?.success === 15 ? "STEAM_INVENTORY_PRIVATE" : "STEAM_INVENTORY_FETCH_FAILED";
      throw attachDebug(error, debug);
    }

    for (const asset of payload.assets || []) {
      assets.push(asset);
    }

    for (const description of payload.descriptions || []) {
      descriptions.set(`${description.classid}_${description.instanceid}`, description);
    }

    more = !!payload.more_items;
    startAssetId = payload.last_assetid || null;
  }

  return { assets, descriptions, debug };
}

function buildDefaultListingUrl(item) {
  if (!item.marketable) return null;
  return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.marketHashName)}`;
}

function groupInventoryItems(raw, valuationLookup) {
  const grouped = new Map();

  for (const asset of raw.assets) {
    const description = raw.descriptions.get(`${asset.classid}_${asset.instanceid}`);
    if (!description) continue;

    const name = description.market_hash_name || description.market_name || description.name;
    if (!name) continue;

    const quantity = Math.max(1, Number.parseInt(asset.amount || "1", 10) || 1);
    const key = normalizeName(name);
    const existing = grouped.get(key) || {
      key,
      name,
      type: description.type || null,
      iconUrl: description.icon_url
        ? `https://community.fastly.steamstatic.com/economy/image/${description.icon_url}/96fx96f`
        : null,
      marketHashName: description.market_hash_name || name,
      tradable: description.tradable === 1,
      marketable: description.marketable === 1,
      commodity: description.commodity === 1,
      quantity: 0,
      assets: 0,
    };

    existing.quantity += quantity;
    existing.assets += 1;
    grouped.set(key, existing);
  }

  const items = [...grouped.values()].map((item) => {
    const valuation = valuationLookup ? valuationLookup(item) : null;
    const unitPriceEur = safeNum(valuation?.unitPriceEur);
    const totalPriceEur = unitPriceEur != null ? unitPriceEur * item.quantity : null;

    return {
      ...item,
      iconUrl: valuation?.iconUrl || item.iconUrl || null,
      unitPriceEur,
      totalPriceEur,
      matched: !!valuation?.matched,
      source: valuation?.source || null,
      listingUrl: valuation?.listingUrl || buildDefaultListingUrl(item),
      sellListings: safeNum(valuation?.sellListings),
      priceUpdatedAt: valuation?.priceUpdatedAt || null,
      dashboardKey: null,
      dashboardItem: null,
    };
  });

  items.sort((left, right) => {
    const totalDiff = (right.totalPriceEur ?? -1) - (left.totalPriceEur ?? -1);
    if (totalDiff !== 0) return totalDiff;
    return left.name.localeCompare(right.name);
  });

  return items;
}

async function enrichWithLivePrices(items, cache, limit = 24) {
  const targets = items
    .filter((item) => item.unitPriceEur == null && item.marketable)
    .slice(0, Math.max(0, limit));

  for (const item of targets) {
    const cacheKey = normalizeName(item.marketHashName || item.name);
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      item.unitPriceEur = cached.unitPriceEur;
      item.totalPriceEur = item.unitPriceEur != null ? item.unitPriceEur * item.quantity : null;
      item.source = cached.source;
      item.listingUrl = cached.listingUrl || item.listingUrl;
      item.matched = !!cached.matched;
      item.sellListings = safeNum(cached.sellListings);
      item.priceUpdatedAt = cached.priceUpdatedAt || item.priceUpdatedAt || null;
      continue;
    }

    try {
      const market = await fetchSteamOverview(item.marketHashName || item.name, 3);
      let unitPriceEur = safeNum(market.lowestPriceEur ?? market.medianPriceEur);

      if (unitPriceEur == null) {
        try {
          const fullMarket = await fetchSteamMarket(item.marketHashName || item.name, {
            includeOrderbook: false,
          });
          unitPriceEur = safeNum(
            fullMarket?.overview?.lowestPriceEur ??
              fullMarket?.overview?.medianPriceEur ??
              fullMarket?.summary?.latestPriceEur
          );
        } catch {
          unitPriceEur = null;
        }
      }

      const cached = {
        unitPriceEur,
        source: unitPriceEur != null ? "steam-live" : null,
        listingUrl: item.listingUrl,
        matched: unitPriceEur != null,
        sellListings: safeNum(market?.volume),
        priceUpdatedAt: new Date().toISOString(),
      };
      cache.set(cacheKey, cached);

      if (unitPriceEur != null) {
        item.unitPriceEur = unitPriceEur;
        item.totalPriceEur = unitPriceEur * item.quantity;
        item.source = "steam-live";
        item.matched = true;
        item.sellListings = cached.sellListings;
        item.priceUpdatedAt = cached.priceUpdatedAt;
      }
    } catch {
      cache.set(cacheKey, {
        unitPriceEur: null,
        source: null,
        listingUrl: item.listingUrl,
        matched: false,
        sellListings: null,
        priceUpdatedAt: null,
      });
    }
  }

  return items;
}

function summarizeInventory(profile, items) {
  const valuedItems = items.filter((item) => item.totalPriceEur != null);
  const matchedItems = items.filter((item) => item.matched);

  return {
    profile,
    fetchedAt: new Date().toISOString(),
    totals: {
      uniqueItems: items.length,
      totalQuantity: items.reduce((sum, item) => sum + (item.quantity || 0), 0),
      matchedItems: matchedItems.length,
      marketableItems: items.filter((item) => item.marketable).length,
      estimatedValueEur: valuedItems.reduce((sum, item) => sum + (item.totalPriceEur || 0), 0),
    },
    items,
  };
}

module.exports = {
  enrichWithLivePrices,
  fetchSteamInventory,
  groupInventoryItems,
  previewText,
  summarizeInventory,
};