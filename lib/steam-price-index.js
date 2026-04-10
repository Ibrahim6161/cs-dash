const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./dashboard-analytics-v2");

function safeNum(value) {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload;

  if (isPlainObject(payload)) {
    const candidateKeys = [
      "items",
      "results",
      "data",
      "skins",
      "cases",
      "rows",
      "entries",
    ];

    for (const key of candidateKeys) {
      if (Array.isArray(payload[key])) return payload[key];
    }

    const values = Object.values(payload);
    if (values.every((value) => isPlainObject(value))) {
      return values;
    }
  }

  return [];
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return asArray(JSON.parse(raw));
  } catch {
    return [];
  }
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickFirstNumber(...values) {
  for (const value of values) {
    const num = safeNum(value);
    if (num != null) return num;
  }
  return null;
}

function extractListingUrl(entry, hashName) {
  const direct =
    pickFirstString(
      entry.listingUrl,
      entry.marketUrl,
      entry.marketURL,
      entry.url,
      entry.steamUrl,
      entry.steamURL,
      entry?.urls?.steam
    ) || null;

  if (direct) return direct;

  if (!hashName) return null;
  return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(hashName)}`;
}

function extractIconUrl(entry) {
  return (
    pickFirstString(
      entry.iconUrl,
      entry.image,
      entry.imageUrl,
      entry.icon,
      entry.img,
      entry?.steam?.iconUrl
    ) || null
  );
}

function normalizeRecord(entry, sourceFile) {
  const hashName = pickFirstString(
    entry.hashName,
    entry.market_hash_name,
    entry.marketHashName,
    entry.name
  );

  const name = pickFirstString(
    entry.name,
    entry.marketName,
    entry.market_name,
    hashName
  );

  if (!hashName && !name) return null;

  const steamPriceEur = pickFirstNumber(
    entry.steamPriceEur,
    entry.priceEur,
    entry.price_eur,
    entry.steam_price_eur,
    entry.price,
    entry?.steam?.priceEur,
    entry?.steam?.steamPriceEur,
    entry?.overview?.lowestPriceEur,
    entry?.overview?.medianPriceEur,
    entry?.summary?.latestPriceEur
  );

  const sellListings = pickFirstNumber(
    entry.sellListings,
    entry.listings,
    entry.sell_listings,
    entry?.steam?.sellListings,
    entry?.overview?.volume
  );

  const recordHashName = hashName || name;

  return {
    key: normalizeName(recordHashName),
    hashName: recordHashName,
    name: name || recordHashName,
    steamPriceEur,
    sellListings,
    iconUrl: extractIconUrl(entry),
    listingUrl: extractListingUrl(entry, recordHashName),
    source: sourceFile,
  };
}

function setIndexRecord(index, key, record) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, record);
    return;
  }

  const existing = index.get(key);

  const existingScore =
    (existing.steamPriceEur != null ? 2 : 0) +
    (existing.sellListings != null ? 1 : 0) +
    (existing.iconUrl ? 1 : 0);

  const incomingScore =
    (record.steamPriceEur != null ? 2 : 0) +
    (record.sellListings != null ? 1 : 0) +
    (record.iconUrl ? 1 : 0);

  if (incomingScore > existingScore) {
    index.set(key, record);
  }
}

function addRecordsToIndex(index, entries, sourceFile) {
  for (const entry of entries) {
    const record = normalizeRecord(entry, sourceFile);
    if (!record) continue;

    if (record.hashName) {
      setIndexRecord(index.byHashName, record.hashName.trim().toLowerCase(), record);
      setIndexRecord(index.byNormalized, normalizeName(record.hashName), record);
    }

    if (record.name) {
      setIndexRecord(index.byName, record.name.trim().toLowerCase(), record);
      setIndexRecord(index.byNormalized, normalizeName(record.name), record);
    }
  }
}

function createSteamPriceIndex(rootDir) {
  const skinsPath = path.join(rootDir, "out", "steam-skins.json");
  const casesPath = path.join(rootDir, "out", "steam-cases.json");

  const index = {
    byHashName: new Map(),
    byName: new Map(),
    byNormalized: new Map(),
    meta: {
      builtAt: new Date().toISOString(),
      files: {
        skinsPath,
        casesPath,
        skinsExists: fs.existsSync(skinsPath),
        casesExists: fs.existsSync(casesPath),
      },
      counts: {
        skins: 0,
        cases: 0,
        indexed: 0,
      },
    },
  };

  const skins = readJsonIfExists(skinsPath);
  const cases = readJsonIfExists(casesPath);

  addRecordsToIndex(index, skins, "steam-skins");
  addRecordsToIndex(index, cases, "steam-cases");

  index.meta.counts.skins = skins.length;
  index.meta.counts.cases = cases.length;
  index.meta.counts.indexed = index.byNormalized.size;

  return index;
}

function lookupSteamPrice(index, inventoryItem) {
  if (!index) return null;

  const hashNameKey = String(inventoryItem.marketHashName || "").trim().toLowerCase();
  const nameKey = String(inventoryItem.name || "").trim().toLowerCase();
  const normalizedHash = normalizeName(inventoryItem.marketHashName || "");
  const normalizedName = normalizeName(inventoryItem.name || "");

  return (
    index.byHashName.get(hashNameKey) ||
    index.byName.get(nameKey) ||
    index.byNormalized.get(normalizedHash) ||
    index.byNormalized.get(normalizedName) ||
    null
  );
}

module.exports = {
  createSteamPriceIndex,
  lookupSteamPrice,
};