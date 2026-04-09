const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(process.cwd(), "out");
const OUT_FILE = path.join(OUT_DIR, "steam-skins.json");
const CHECKPOINT_FILE = path.join(OUT_DIR, "steam-skins-checkpoint.json");

// Steam lijkt hier effectief maar 10 resultaten per request terug te geven.
// Dus niet vertrouwen op count=100.
const REQUEST_COUNT = 10;

// Veilig per run beperken. Dan kun je in meerdere runs bouwen.
const MAX_PAGES_PER_RUN = Number(process.env.MAX_PAGES_PER_RUN || 150);

// Vertraging tussen requests. Hoger = veiliger.
const BASE_DELAY_MS = Number(process.env.BASE_DELAY_MS || 4500);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 8);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms, pct = 0.2) {
  const delta = Math.floor(ms * pct);
  return ms + Math.floor(Math.random() * (delta * 2 + 1)) - delta;
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function request(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;

  return new Promise((resolve, reject) => {
    const req = https.get(url, options, (res) => {
      const chunks = [];

      res.on("data", (chunk) => {
        chunks.push(chunk);
      });

      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          buffer: Buffer.concat(chunks),
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    req.on("error", reject);
  });
}

function decodeBody(buffer, contentEncoding) {
  const encoding = String(contentEncoding || "").toLowerCase();

  try {
    if (encoding.includes("br")) {
      return zlib.brotliDecompressSync(buffer).toString("utf8");
    }
    if (encoding.includes("gzip")) {
      return zlib.gunzipSync(buffer).toString("utf8");
    }
    if (encoding.includes("deflate")) {
      return zlib.inflateSync(buffer).toString("utf8");
    }
  } catch {
    return buffer.toString("utf8");
  }

  return buffer.toString("utf8");
}

async function requestJson(url, attempt = 1) {
  const response = await request(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      accept: "application/json,text/plain,*/*",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip, deflate, br",
      referer: "https://steamcommunity.com/market/search?appid=730",
      origin: "https://steamcommunity.com",
      pragma: "no-cache",
      "cache-control": "no-cache",
    },
    timeoutMs: 30000,
  });

  const statusCode = response.statusCode;
  const headers = response.headers;
  const contentType = String(headers["content-type"] || "").toLowerCase();
  const body = decodeBody(response.buffer, headers["content-encoding"]);

  if (statusCode >= 300 && statusCode < 400 && headers.location) {
    throw new Error(`Redirect received (${statusCode}) to ${headers.location}`);
  }

  if (statusCode === 429) {
    if (attempt < MAX_RETRIES) {
      const retryAfterHeader = Number(headers["retry-after"]);
      const retryDelay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(60000 * attempt, 10 * 60 * 1000);

      console.warn(
        `Steam returned 429. Retry ${attempt}/${MAX_RETRIES - 1} after ${retryDelay}ms`
      );
      await sleep(jitter(retryDelay, 0.15));
      return requestJson(url, attempt + 1);
    }

    throw new Error(
      `Steam request failed after retries with status 429. Body starts with: ${body.slice(0, 300)}`
    );
  }

  if (statusCode >= 500) {
    if (attempt < MAX_RETRIES) {
      const retryDelay = Math.min(5000 * attempt, 60000);
      console.warn(
        `Steam returned ${statusCode}. Retry ${attempt}/${MAX_RETRIES - 1} after ${retryDelay}ms`
      );
      await sleep(jitter(retryDelay, 0.15));
      return requestJson(url, attempt + 1);
    }

    throw new Error(
      `Steam request failed after retries with status ${statusCode}. Body starts with: ${body.slice(0, 300)}`
    );
  }

  if (statusCode !== 200) {
    throw new Error(
      `Unexpected status ${statusCode}. Content-Type="${contentType}". Body starts with: ${body.slice(0, 300)}`
    );
  }

  if (!contentType.includes("application/json") && !body.trim().startsWith("{")) {
    throw new Error(
      `Expected JSON but got content-type="${contentType}" and body starts with: ${body.slice(0, 300)}`
    );
  }

  try {
    return {
      statusCode,
      payload: JSON.parse(body || "{}"),
    };
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      const retryDelay = 3000 * attempt;
      console.warn(
        `JSON parse failed on attempt ${attempt}/${MAX_RETRIES - 1}. Retrying after ${retryDelay}ms`
      );
      await sleep(jitter(retryDelay, 0.15));
      return requestJson(url, attempt + 1);
    }

    throw new Error(
      `Invalid JSON response: ${error.message}. Body starts with: ${body.slice(0, 300)}`
    );
  }
}

function extractPriceEur(value) {
  if (!value) return null;

  const cleaned = String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/[^0-9,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  const numeric = Number.parseFloat(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isExcludedType(typeText, nameText) {
  const type = cleanText(typeText).toLowerCase();
  const name = cleanText(nameText).toLowerCase();
  const text = `${type} ${name}`;

  const excludedKeywords = [
    "case",
    "capsule",
    "sticker",
    "graffiti",
    "music kit",
    "agent",
    "patch",
    "key",
    "pass",
    "storage unit",
    "collectible",
    "souvenir package",
    "name tag",
    "viewer pass",
    "tool",
    "spray",
    "gift package",
    "crate",
    "charm",
  ];

  return excludedKeywords.some((keyword) => text.includes(keyword));
}

function looksLikeSkin(item) {
  const name = cleanText(item?.hash_name || item?.name || "");
  const type = cleanText(item?.asset_description?.type || "");
  const marketName = `${name} ${type}`.toLowerCase();

  if (!name) return false;
  if (isExcludedType(type, name)) return false;

  if (marketName.includes("knife")) return true;
  if (marketName.includes("gloves")) return true;
  if (name.includes("|")) return true;

  const weaponHints = [
    "rifle",
    "sniper rifle",
    "pistol",
    "smg",
    "shotgun",
    "machinegun",
    "submachine gun",
  ];

  return weaponHints.some((hint) => marketName.includes(hint));
}

function inferSkinCategory(name, typeText) {
  const text = `${cleanText(name)} ${cleanText(typeText)}`.toLowerCase();

  if (text.includes("knife")) return "Knife";
  if (text.includes("gloves")) return "Gloves";
  if (text.includes("pistol")) return "Pistol";
  if (text.includes("sniper")) return "Sniper";
  if (text.includes("smg") || text.includes("submachine")) return "SMG";
  if (text.includes("shotgun")) return "Shotgun";
  if (text.includes("machinegun")) return "Machinegun";
  if (text.includes("rifle")) return "Rifle";

  if (
    text.includes("ak-47") ||
    text.includes("m4a1") ||
    text.includes("m4a4") ||
    text.includes("aug") ||
    text.includes("famas") ||
    text.includes("galil") ||
    text.includes("sg 553")
  ) return "Rifle";

  if (
    text.includes("awp") ||
    text.includes("ssg 08") ||
    text.includes("scar-20") ||
    text.includes("g3sg1")
  ) return "Sniper";

  if (
    text.includes("glock-18") ||
    text.includes("usp-s") ||
    text.includes("p250") ||
    text.includes("five-seven") ||
    text.includes("tec-9") ||
    text.includes("desert eagle") ||
    text.includes("dual berettas") ||
    text.includes("cz75-auto") ||
    text.includes("r8 revolver")
  ) return "Pistol";

  if (
    text.includes("mac-10") ||
    text.includes("mp9") ||
    text.includes("mp7") ||
    text.includes("ump-45") ||
    text.includes("pp-bizon") ||
    text.includes("p90") ||
    text.includes("mp5-sd")
  ) return "SMG";

  return "Other";
}

function buildSteamItem(item) {
  const asset = item.asset_description || {};
  const hashName = item.hash_name || item.name || null;
  const iconUrl = asset.icon_url
    ? `https://community.fastly.steamstatic.com/economy/image/${asset.icon_url}/360fx360f`
    : null;

  return {
    hashName,
    name: item.name || hashName || null,
    type: asset.type || null,
    category: inferSkinCategory(hashName, asset.type || ""),
    sellListings: item.sell_listings ?? null,
    sellPriceText: item.sell_price_text || null,
    salePriceText: item.sale_price_text || null,
    sellPriceEur: extractPriceEur(item.sell_price_text || item.sale_price_text),
    marketable: asset.marketable === 1,
    tradable: asset.tradable === 1,
    commodity: asset.commodity === 1,
    nameColor: asset.name_color || null,
    iconUrl,
    marketUrl: hashName
      ? `https://steamcommunity.com/market/listings/730/${encodeURIComponent(hashName)}`
      : null,
    appName: item.app_name || null,
    assetDescription: asset,
  };
}

function loadCheckpoint() {
  ensureOutDir();

  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return {
      startedAt: new Date().toISOString(),
      updatedAt: null,
      totalCountReported: null,
      nextStart: 0,
      rawItems: [],
      pagesFetchedThisRun: 0,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    return {
      startedAt: parsed.startedAt || new Date().toISOString(),
      updatedAt: parsed.updatedAt || null,
      totalCountReported: parsed.totalCountReported ?? null,
      nextStart: Number(parsed.nextStart || 0),
      rawItems: Array.isArray(parsed.rawItems) ? parsed.rawItems : [],
      pagesFetchedThisRun: 0,
    };
  } catch {
    return {
      startedAt: new Date().toISOString(),
      updatedAt: null,
      totalCountReported: null,
      nextStart: 0,
      rawItems: [],
      pagesFetchedThisRun: 0,
    };
  }
}

function saveCheckpoint(state) {
  ensureOutDir();
  fs.writeFileSync(
    CHECKPOINT_FILE,
    JSON.stringify(
      {
        startedAt: state.startedAt,
        updatedAt: new Date().toISOString(),
        totalCountReported: state.totalCountReported,
        nextStart: state.nextStart,
        rawItems: state.rawItems,
      },
      null,
      2
    ),
    "utf8"
  );
}

function finalizeOutput(rawItems, totalCountReported) {
  const skins = rawItems
    .filter(looksLikeSkin)
    .map(buildSteamItem)
    .filter((item) => item.hashName);

  const uniqueByHash = new Map();
  for (const item of skins) {
    uniqueByHash.set(item.hashName, item);
  }

  const finalItems = [...uniqueByHash.values()].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""))
  );

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: "steam-market-search-render",
    rawCount: rawItems.length,
    totalCountReported,
    skinCount: finalItems.length,
    items: finalItems,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function fetchAllSteam730Items() {
  const state = loadCheckpoint();

  console.log(`Resuming from start=${state.nextStart}`);
  console.log(`Stored raw items so far: ${state.rawItems.length}`);
  console.log(`Max pages this run: ${MAX_PAGES_PER_RUN}`);
  console.log(`Base delay: ${BASE_DELAY_MS}ms`);

  while (true) {
    if (state.pagesFetchedThisRun >= MAX_PAGES_PER_RUN) {
      console.log(`Reached MAX_PAGES_PER_RUN=${MAX_PAGES_PER_RUN}. Stopping this run safely.`);
      break;
    }

    const url =
      "https://steamcommunity.com/market/search/render/?" +
      [
        "appid=730",
        "norender=1",
        "sort_column=popular",
        "sort_dir=desc",
        `start=${state.nextStart}`,
        `count=${REQUEST_COUNT}`,
      ].join("&");

    console.log(`Fetching ${url}`);

    const response = await requestJson(url);
    const payload = response.payload;
    const results = Array.isArray(payload.results) ? payload.results : [];

    if (state.totalCountReported == null) {
      state.totalCountReported = Number(payload.total_count || 0);
      console.log(`Total Steam CS2 market items reported: ${state.totalCountReported}`);
    }

    if (!results.length) {
      console.log(`No results returned at start=${state.nextStart}, stopping.`);
      break;
    }

    state.rawItems.push(...results);
    state.nextStart += results.length;
    state.pagesFetchedThisRun += 1;

    console.log(
      `Fetched so far this dataset: ${state.rawItems.length}/${state.totalCountReported ?? "?"} | nextStart=${state.nextStart}`
    );

    saveCheckpoint(state);
    finalizeOutput(state.rawItems, state.totalCountReported);

    if (state.nextStart >= state.totalCountReported) {
      console.log("Reached reported total count.");
      break;
    }

    await sleep(jitter(BASE_DELAY_MS, 0.2));
  }

  return {
    fetchedAt: new Date().toISOString(),
    totalCountReported: state.totalCountReported,
    rawCount: state.rawItems.length,
    items: state.rawItems,
    nextStart: state.nextStart,
    completed:
      state.totalCountReported != null &&
      state.nextStart >= state.totalCountReported,
  };
}

async function main() {
  ensureOutDir();

  const raw = await fetchAllSteam730Items();
  const payload = finalizeOutput(raw.items, raw.totalCountReported);

  console.log(`Saved ${payload.skinCount} skins to ${OUT_FILE}`);
  console.log(`Checkpoint at start=${raw.nextStart}`);
  console.log(`Completed: ${raw.completed ? "yes" : "no"}`);
  console.log(`Checkpoint file: ${CHECKPOINT_FILE}`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});