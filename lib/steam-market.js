const https = require("https");
const { URL } = require("url");
const zlib = require("zlib");

function cleanText(value) {
  return String(value || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function safeNum(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function buildHeaders(extra = {}) {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    referer: "https://steamcommunity.com/market/",
    origin: "https://steamcommunity.com",
    ...extra,
  };
}

function requestRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const request = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: buildHeaders(headers),
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

          resolve({
            statusCode: response.statusCode || 0,
            body: decoded.toString("utf8"),
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

async function requestText(url, headers = {}) {
  return requestRaw(url, headers);
}

async function requestJson(url, headers = {}) {
  const response = await requestRaw(url, {
    accept: "application/json,text/plain,*/*",
    ...headers,
  });

  let payload = null;
  try {
    payload = JSON.parse(response.body || "{}");
  } catch {
    payload = null;
  }

  return {
    ...response,
    payload,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEuroNumber(value) {
  if (!value) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const original = cleanText(value);
  const cleaned = original
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  const numeric = Number.parseFloat(cleaned);
  if (!Number.isFinite(numeric)) return null;

  if (!/[,.€$]/.test(original) && /^\d+$/.test(cleaned) && numeric >= 100) {
    return numeric / 100;
  }

  return numeric;
}

function parseVolume(value) {
  if (!value) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const cleaned = cleanText(value).replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const normalized =
    cleaned.includes(",") && cleaned.includes(".")
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");

  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIsoDate(label) {
  const text = cleanText(label);

  const fromNative = new Date(text);
  if (!Number.isNaN(fromNative.getTime())) {
    return fromNative.toISOString();
  }

  const match = text.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (!match) return null;

  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} 00:00:00 UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseHistoryArray(raw) {
  if (!raw) return [];

  let parsed = [];
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((point) => {
      if (!Array.isArray(point) || point.length < 3) return null;

      const price = safeNum(point[1]);
      const volume = safeNum(point[2]);

      if (price == null) return null;

      return {
        label: cleanText(point[0]),
        date: toIsoDate(point[0]),
        price,
        volume,
      };
    })
    .filter(Boolean);
}

function summariseHistory(points) {
  if (!Array.isArray(points) || !points.length) {
    return {
      latestPriceEur: null,
      change7dPct: null,
      change30dPct: null,
      change90dPct: null,
      low30dEur: null,
      high30dEur: null,
      avgVolume30d: null,
      volatility30dPct: null,
      spark: [],
    };
  }

  const latest = points[points.length - 1];
  const tail = (count) => points.slice(Math.max(0, points.length - count));
  const points7 = tail(7);
  const points30 = tail(30);
  const points90 = tail(90);

  const pct = (current, previous) => {
    if (current == null || previous == null || previous === 0) return null;
    return ((current - previous) / previous) * 100;
  };

  const prices30 = points30.map((point) => point.price).filter((value) => value != null);
  const avg30 = prices30.length ? prices30.reduce((sum, value) => sum + value, 0) / prices30.length : null;
  const variance30 =
    avg30 == null
      ? null
      : prices30.reduce((sum, value) => sum + Math.pow(value - avg30, 2), 0) / Math.max(1, prices30.length);

  return {
    latestPriceEur: latest.price,
    change7dPct: points7.length >= 2 ? pct(points7[points7.length - 1].price, points7[0].price) : null,
    change30dPct: points30.length >= 2 ? pct(points30[points30.length - 1].price, points30[0].price) : null,
    change90dPct: points90.length >= 2 ? pct(points90[points90.length - 1].price, points90[0].price) : null,
    low30dEur: prices30.length ? Math.min(...prices30) : null,
    high30dEur: prices30.length ? Math.max(...prices30) : null,
    avgVolume30d: points30.length
      ? points30.reduce((sum, point) => sum + (point.volume || 0), 0) / points30.length
      : null,
    volatility30dPct:
      avg30 && variance30 != null
        ? clamp01((Math.sqrt(variance30) / avg30) * 10) * 100
        : null,
    spark: points30.slice(-24).map((point) => point.price),
  };
}

function extractHistoryScript(html) {
  if (!html) return [];

  const patterns = [
    /var\s+line1\s*=\s*(\[[\s\S]*?\]);/,
    /var\s+g_plotPriceHistoryData\s*=\s*(\[[\s\S]*?\]);/,
    /"price_history"\s*:\s*(\[[\s\S]*?\])/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const parsed = parseHistoryArray(match ? match[1] : null);
    if (parsed.length) return parsed;
  }

  return [];
}

function extractItemNameId(html) {
  if (!html) return null;

  const patterns = [
    /Market_LoadOrderSpread\(\s*(\d+)\s*\)/,
    /item_nameid["']?\s*[:=]\s*["']?(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function deriveLevels(graph, direction) {
  if (!Array.isArray(graph)) return [];
  const levels = [];
  let previous = 0;

  for (const point of graph.slice(0, 8)) {
    if (!Array.isArray(point) || point.length < 2) continue;

    const price = safeNum(point[0]);
    const cumulative = safeNum(point[1]);
    if (price == null || cumulative == null) continue;

    const quantity = Math.max(0, cumulative - previous);
    previous = cumulative;

    levels.push({
      priceEur: price,
      quantity,
      side: direction,
      label: cleanText(point[2]),
    });
  }

  return levels;
}

function parseOrderbook(payload) {
  if (!payload || Number(payload.success) !== 1) return null;

  const lowestSellEur = parseEuroNumber(payload.lowest_sell_order);
  const highestBuyEur = parseEuroNumber(payload.highest_buy_order);
  const spreadPct =
    lowestSellEur && highestBuyEur
      ? ((lowestSellEur - highestBuyEur) / ((lowestSellEur + highestBuyEur) / 2)) * 100
      : null;

  return {
    lowestSellEur,
    highestBuyEur,
    spreadPct,
    buyLevels: deriveLevels(payload.buy_order_graph, "buy"),
    sellLevels: deriveLevels(payload.sell_order_graph, "sell"),
    graphMaxY: safeNum(payload.graph_max_y),
    graphMinX: safeNum(payload.graph_min_x),
    graphMaxX: safeNum(payload.graph_max_x),
  };
}

function buildListingUrl(name) {
  return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`;
}

async function fetchSteamOverview(name, currency = 3) {
  const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=${currency}&market_hash_name=${encodeURIComponent(name)}`;
  let response = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await requestText(url, { accept: "application/json,text/plain,*/*" });

    if (response.statusCode === 429) {
      await sleep(800 + (attempt * 700));
      continue;
    }

    break;
  }

  if (!response || response.statusCode !== 200) {
    return {
      lowestPriceEur: null,
      medianPriceEur: null,
      volume: null,
      failed: true,
      statusCode: response?.statusCode || 0,
    };
  }

  const payload = JSON.parse(response.body || "{}");
  if (!payload.success) {
    return {
      lowestPriceEur: null,
      medianPriceEur: null,
      volume: null,
      failed: true,
      statusCode: response.statusCode,
    };
  }

  return {
    lowestPriceEur: parseEuroNumber(payload.lowest_price),
    medianPriceEur: parseEuroNumber(payload.median_price),
    volume: parseVolume(payload.volume),
    failed: false,
    statusCode: response.statusCode,
  };
}

async function fetchSteamPriceHistory(name) {
  const url =
    `https://steamcommunity.com/market/pricehistory/` +
    `?appid=730&market_hash_name=${encodeURIComponent(name)}`;

  let response = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await requestJson(url);

    if (response.statusCode === 429) {
      await sleep(1000 + (attempt * 900));
      continue;
    }

    break;
  }

  if (!response || response.statusCode !== 200 || !response.payload) {
    return {
      ok: false,
      statusCode: response?.statusCode || 0,
      history: [],
      source: "pricehistory",
    };
  }

  const payload = response.payload;
  const history = parseHistoryArray(payload?.prices || payload?.price_history || []);

  if (!history.length) {
    return {
      ok: false,
      statusCode: response.statusCode,
      history: [],
      source: "pricehistory",
    };
  }

  return {
    ok: true,
    statusCode: response.statusCode,
    history,
    source: "pricehistory",
  };
}

async function fetchSteamMarket(name, options = {}) {
  const currency = options.currency || 3;
  const country = options.country || "NL";
  const language = options.language || "english";
  const includeOrderbook = !!options.includeOrderbook;

  const [overview, historyResponse, listingResponse] = await Promise.all([
    fetchSteamOverview(name, currency),
    fetchSteamPriceHistory(name),
    requestText(buildListingUrl(name), {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
  ]);

  if (listingResponse.statusCode !== 200) {
    throw new Error(`Steam listing failed (${listingResponse.statusCode}) for ${name}`);
  }

  let history = historyResponse.ok ? historyResponse.history : [];
  let historySource = historyResponse.ok ? historyResponse.source : null;

  if (!history.length) {
    history = extractHistoryScript(listingResponse.body);
    if (history.length) {
      historySource = "listing-html";
    }
  }

  const itemNameId = extractItemNameId(listingResponse.body);
  const summary = summariseHistory(history);

  let orderbook = null;
  if ((includeOrderbook || overview.failed) && itemNameId) {
    const orderbookUrl =
      `https://steamcommunity.com/market/itemordershistogram` +
      `?country=${country}&language=${language}&currency=${currency}&item_nameid=${itemNameId}&two_factor=0`;

    const orderbookResponse = await requestText(orderbookUrl, {
      accept: "application/json,text/plain,*/*",
    });

    if (orderbookResponse.statusCode === 200) {
      try {
        orderbook = parseOrderbook(JSON.parse(orderbookResponse.body || "{}"));
      } catch {
        orderbook = null;
      }
    }
  }

  if (overview.lowestPriceEur == null && orderbook?.lowestSellEur != null) {
    overview.lowestPriceEur = orderbook.lowestSellEur;
  }

  if (overview.medianPriceEur == null && summary.latestPriceEur != null) {
    overview.medianPriceEur = summary.latestPriceEur;
  }

  return {
    name,
    fetchedAt: new Date().toISOString(),
    listingUrl: buildListingUrl(name),
    itemNameId,
    historySource,
    overview,
    summary,
    history,
    orderbook,
  };
}

module.exports = {
  buildListingUrl,
  cleanText,
  fetchSteamMarket,
  fetchSteamOverview,
  fetchSteamPriceHistory,
  parseEuroNumber,
  parseVolume,
  summariseHistory,
};