const fs = require("fs");
const path = require("path");
const { fetchSteamMarket, cleanText } = require("./lib/steam-market");

function getArg(name, fallback = null, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectNames(sourcePath, casesPath) {
  const names = new Set();
  const ordered = [];

  const pushName = (value) => {
    const cleaned = cleanText(value);
    if (!cleaned || names.has(cleaned)) return;
    names.add(cleaned);
    ordered.push(cleaned);
  };

  const cases = readJson(casesPath);
  const universe = Array.isArray(cases?.cases) ? cases.cases : [];
  for (const entry of universe) {
    pushName(entry?.case || entry?.name);
  }

  const source = readJson(sourcePath);
  const sourceMap = source?.map && typeof source.map === "object" ? source.map : {};
  for (const name of Object.keys(sourceMap)) {
    pushName(name);
  }

  return ordered;
}

async function mapLimit(values, limit, iteratee) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await iteratee(values[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function run() {
  const outFile = getArg("--out", "steam_market_data.json");
  const sourcePath = getArg("--source", "pricempire_prices_eur.json");
  const casesPath = getArg("--cases", "cases.json");
  const limit = Number.parseInt(getArg("--limit", "500"), 10) || 500;
  const concurrency = Number.parseInt(getArg("--concurrency", "2"), 10) || 2;

  const names = collectNames(sourcePath, casesPath).slice(0, limit);
  const map = {};
  const errors = [];

  console.log(`Steam scrape queue: ${names.length} item(s)`);

  await mapLimit(names, concurrency, async (name, index) => {
    try {
      console.log(`[${index + 1}/${names.length}] ${name}`);
      const market = await fetchSteamMarket(name, { includeOrderbook: false });
      map[name] = {
        fetchedAt: market.fetchedAt,
        listingUrl: market.listingUrl,
        itemNameId: market.itemNameId,
        overview: market.overview,
        summary: market.summary,
        history: market.history.slice(-180),
      };
    } catch (error) {
      errors.push({
        name,
        reason: error && error.message ? error.message : String(error),
      });
      console.error(`Steam failed for ${name}: ${error && error.message ? error.message : String(error)}`);
    }
  });

  const payload = {
    meta: {
      timestamp: new Date().toISOString(),
      source: "Steam Community Market",
      currency: "EUR",
      scraped: Object.keys(map).length,
      requested: names.length,
      errors: errors.length,
      concurrency,
    },
    map,
    errors,
  };

  ensureDir(outFile);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Steam output -> ${outFile}`);
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
