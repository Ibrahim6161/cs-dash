const https = require("https");
const fs = require("fs");
const path = require("path");

const OUT_FILE = path.join(process.cwd(), "out", "steam-cases.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "accept": "application/json,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
        "referer": "https://steamcommunity.com/market/search?appid=730",
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve({
            statusCode: res.statusCode || 0,
            payload: JSON.parse(body || "{}"),
          });
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    }).on("error", reject);
  });
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

async function fetchAllSteamCases() {
  const count = 100;
  let start = 0;
  let totalCount = null;
  const all = [];

  while (true) {
    const url =
      "https://steamcommunity.com/market/search/render/?" +
      [
        "appid=730",
        "norender=1",
        `start=${start}`,
        `count=${count}`,
        "category_730_Type%5B%5D=tag_CSGO_Type_WeaponCase",
      ].join("&");

    console.log(`Fetching ${url}`);

    const response = await requestJson(url);

    if (response.statusCode !== 200) {
      throw new Error(`Steam search failed with status ${response.statusCode} at start=${start}`);
    }

    const payload = response.payload;
    const results = Array.isArray(payload.results) ? payload.results : [];

    if (totalCount == null) {
      totalCount = Number(payload.total_count || 0);
      console.log(`Total Steam cases reported: ${totalCount}`);
    }

    if (!results.length) {
      break;
    }

    for (const item of results) {
      all.push({
        hashName: item.hash_name || null,
        name: item.name || null,
        sellListings: item.sell_listings ?? null,
        sellPriceText: item.sell_price_text || null,
        salePriceText: item.sale_price_text || null,
        sellPriceEur: extractPriceEur(item.sell_price_text || item.sale_price_text),
        appName: item.app_name || null,
        assetDescription: item.asset_description || null,
      });
    }

    start += results.length;

    if (start >= totalCount) {
      break;
    }

    await sleep(1200);
  }

  return {
    fetchedAt: new Date().toISOString(),
    totalCountReported: totalCount,
    count: all.length,
    items: all,
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const payload = await fetchAllSteamCases();
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${payload.count} cases to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});