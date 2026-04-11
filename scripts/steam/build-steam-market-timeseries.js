#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { fetchSteamMarket } = require("../lib/steam-market");
const { normalizeName } = require("../lib/dashboard-analytics-v2");

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "out");

const STEAM_CASES_PATH = path.join(OUT_DIR, "steam-cases.json");
const STEAM_SKINS_PATH = path.join(OUT_DIR, "steam-skins.json");

const OUTPUT_PATH = path.join(OUT_DIR, "steam-market-timeseries.json");
const CHECKPOINT_PATH = path.join(OUT_DIR, "steam-market-timeseries.checkpoint.json");

const DEFAULT_DELAY_MS = Math.max(1200, Number(process.env.STEAM_HISTORY_DELAY_MS) || 2200);
const DEFAULT_LIMIT = Math.max(1, Number(process.env.STEAM_HISTORY_LIMIT) || 999999);
const DEFAULT_RESUME = process.env.STEAM_HISTORY_RESUME !== "0";
const DEFAULT_FORCE = process.env.STEAM_HISTORY_FORCE === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeNum(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const args = {
    delayMs: DEFAULT_DELAY_MS,
    limit: DEFAULT_LIMIT,
    resume: DEFAULT_RESUME,
    force: DEFAULT_FORCE,
    only: null,
    types: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--delay" && argv[i + 1]) {
      args.delayMs = Math.max(500, Number(argv[i + 1]) || DEFAULT_DELAY_MS);
      i += 1;
      continue;
    }

    if (arg === "--limit" && argv[i + 1]) {
      args.limit = Math.max(1, Number(argv[i + 1]) || DEFAULT_LIMIT);
      i += 1;
      continue;
    }

    if (arg === "--resume") {
      args.resume = true;
      continue;
    }

    if (arg === "--no-resume") {
      args.resume = false;
      continue;
    }

    if (arg === "--force") {
      args.force = true;
      continue;
    }

    if (arg === "--only" && argv[i + 1]) {
      args.only = cleanText(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === "--types" && argv[i + 1]) {
      args.types = String(argv[i + 1])
        .split(",")
        .map((value) => cleanText(value).toLowerCase())
        .filter(Boolean);
      i += 1;
      continue;
    }
  }

  return args;
}

function inferCategory(name, type) {
  const text = `${cleanText(name)} ${cleanText(type)}`.toLowerCase();

  if (/\bsouvenir\b/.test(text) && /\bpackage\b/.test(text)) return "souvenir";
  if (/\bsticker capsule\b|\bautograph capsule\b|\bcapsule\b|\brmr\b/.test(text)) return "capsule";
  if (/\bsticker\b|\bfoil\b|\bholo\b|\bglitter\b|\bgold\b|\blenticular\b/.test(text)) return "sticker";
  if (/\bcollection package\b|\bpackage\b/.test(text)) return "package";
  if (/\bgraffiti\b|\bsealed graffiti\b/.test(text)) return "graffiti";
  if (/\bpatch\b|\bpatch pack\b/.test(text)) return "patch";
  if (/\bmusic kit\b|\bkit box\b/.test(text)) return "music_kit";
  if (/\bpin\b|\bpins\b/.test(text)) return "pin";
  if (/\bviewer pass\b|\boperation pass\b|\bpass\b/.test(text)) return "pass";
  if (/\bkey\b/.test(text)) return "key";
  if (/\bgift\b/.test(text)) return "gift";
  if (/\bname tag\b|\bstattrak swap tool\b|\bstorage unit\b|\btool\b/.test(text)) return "tool";
  if (/\bweapon case\b|\bcase\b/.test(text)) return "case";
  if (
    /\brifle\b|\bsniper\b|\bpistol\b|\bsmg\b|\bshotgun\b|\bmachinegun\b|\bknife\b|\bgloves\b/.test(text)
  ) {
    return "skin";
  }
  if (/\bbox\b|\bcontainer\b/.test(text)) return "container";
  return "other";
}

function pushCandidate(map, item) {
  if (!item?.hashName) return;
  const key = normalizeName(item.hashName);

  if (!map.has(key)) {
    map.set(key, item);
    return;
  }

  const existing = map.get(key);
  const existingScore =
    (existing.priceEur != null ? 2 : 0) +
    (existing.listings != null ? 1 : 0) +
    (existing.iconUrl ? 1 : 0);

  const incomingScore =
    (item.priceEur != null ? 2 : 0) +
    (item.listings != null ? 1 : 0) +
    (item.iconUrl ? 1 : 0);

  if (incomingScore > existingScore) {
    map.set(key, item);
  }
}

function loadUniverse() {
  const universe = new Map();

  const steamCases = readJsonIfExists(STEAM_CASES_PATH, {});
  const caseItems = Array.isArray(steamCases?.items) ? steamCases.items : [];
  for (const item of caseItems) {
    const hashName = cleanText(item.hashName || item.name);
    if (!hashName) continue;

    pushCandidate(universe, {
      key: normalizeName(hashName),
      hashName,
      name: cleanText(item.name || hashName),
      category: inferCategory(item.name || hashName, item.assetDescription?.type || item.type),
      type: cleanText(item.assetDescription?.type || item.type),
      marketable: true,
      tradable: item.tradable !== false,
      priceEur: safeNum(item.sellPriceEur),
      listings: safeNum(item.sellListings),
      iconUrl: item.iconUrl || null,
      listingUrl: item.marketUrl || null,
      sourceFile: "steam-cases",
    });
  }

  const steamSkins = readJsonIfExists(STEAM_SKINS_PATH, {});
  const skinItems = Array.isArray(steamSkins?.items) ? steamSkins.items : [];
  for (const item of skinItems) {
    const hashName = cleanText(item.hashName || item.marketHashName || item.name);
    if (!hashName) continue;

    pushCandidate(universe, {
      key: normalizeName(hashName),
      hashName,
      name: cleanText(item.name || hashName),
      category: inferCategory(item.name || hashName, item.assetDescription?.type || item.type || item.category),
      type: cleanText(item.assetDescription?.type || item.type || item.category),
      marketable: item.marketable !== false,
      tradable: item.tradable !== false,
      priceEur: safeNum(item.sellPriceEur ?? item.steamPriceEur),
      listings: safeNum(item.sellListings),
      iconUrl: item.iconUrl || null,
      listingUrl: item.marketUrl || item.listingUrl || null,
      sourceFile: "steam-skins",
    });
  }

  return [...universe.values()].sort((a, b) => a.hashName.localeCompare(b.hashName));
}

function normalizeHistoryPoint(point) {
  if (!point || typeof point !== "object") return null;

  const priceEur = safeNum(point.price);
  if (priceEur == null) return null;

  return {
    date: point.date || point.label || null,
    priceEur,
    volume: safeNum(point.volume),
  };
}

function toOutputItem(base, market) {
  const history = Array.isArray(market?.history)
    ? market.history.map(normalizeHistoryPoint).filter(Boolean)
    : [];

  return {
    key: base.key,
    hashName: base.hashName,
    name: base.name,
    category: base.category,
    type: base.type,
    marketable: base.marketable !== false,
    tradable: base.tradable !== false,
    iconUrl: base.iconUrl || null,
    listingUrl: market?.listingUrl || base.listingUrl || null,
    sourceFile: base.sourceFile,
    fetchedAt: market?.fetchedAt || new Date().toISOString(),
    overview: {
      lowestPriceEur: safeNum(market?.overview?.lowestPriceEur),
      medianPriceEur: safeNum(market?.overview?.medianPriceEur),
      volume: safeNum(market?.overview?.volume),
      failed: !!market?.overview?.failed,
      statusCode: safeNum(market?.overview?.statusCode),
    },
    summary: {
      latestPriceEur: safeNum(market?.summary?.latestPriceEur),
      change7dPct: safeNum(market?.summary?.change7dPct),
      change30dPct: safeNum(market?.summary?.change30dPct),
      change90dPct: safeNum(market?.summary?.change90dPct),
      low30dEur: safeNum(market?.summary?.low30dEur),
      high30dEur: safeNum(market?.summary?.high30dEur),
      avgVolume30d: safeNum(market?.summary?.avgVolume30d),
      volatility30dPct: safeNum(market?.summary?.volatility30dPct),
      spark: Array.isArray(market?.summary?.spark)
        ? market.summary.spark.map(safeNum).filter((value) => value != null)
        : [],
    },
    history,
  };
}

function loadExistingOutput() {
  const payload = readJsonIfExists(OUTPUT_PATH, null);
  if (!payload || !Array.isArray(payload.items)) {
    return {
      fetchedAt: null,
      generatedBy: "build-steam-market-timeseries",
      itemCount: 0,
      items: [],
      failures: [],
    };
  }

  return {
    fetchedAt: payload.fetchedAt || null,
    generatedBy: payload.generatedBy || "build-steam-market-timeseries",
    itemCount: Array.isArray(payload.items) ? payload.items.length : 0,
    items: Array.isArray(payload.items) ? payload.items : [],
    failures: Array.isArray(payload.failures) ? payload.failures : [],
  };
}

function loadCheckpoint() {
  return readJsonIfExists(CHECKPOINT_PATH, {
    updatedAt: null,
    completed: [],
    failures: [],
  });
}

function saveCheckpoint(checkpoint) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2), "utf8");
}

function saveOutput(items, failures) {
  ensureDir(OUT_DIR);

  const sorted = [...items].sort((a, b) => {
    const left = String(a.hashName || a.name || "");
    const right = String(b.hashName || b.name || "");
    return left.localeCompare(right);
  });

  const payload = {
    fetchedAt: new Date().toISOString(),
    generatedBy: "build-steam-market-timeseries",
    itemCount: sorted.length,
    items: sorted,
    failures: failures.sort((a, b) => String(a.hashName || "").localeCompare(String(b.hashName || ""))),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function toFailure(item, error) {
  return {
    hashName: item.hashName,
    name: item.name,
    category: item.category,
    failedAt: new Date().toISOString(),
    error: error && error.message ? error.message : String(error),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(OUT_DIR);

  const universe = loadUniverse();
  if (!universe.length) {
    throw new Error("No Steam market items found in out/steam-cases.json or out/steam-skins.json.");
  }

  const existing = loadExistingOutput();
  const existingMap = new Map();
  for (const item of existing.items) {
    if (item?.hashName) existingMap.set(normalizeName(item.hashName), item);
  }

  const checkpoint = loadCheckpoint();
  const completed = new Set(Array.isArray(checkpoint.completed) ? checkpoint.completed : []);
  const failuresMap = new Map();

  for (const failure of Array.isArray(existing.failures) ? existing.failures : []) {
    if (failure?.hashName) failuresMap.set(normalizeName(failure.hashName), failure);
  }
  for (const failure of Array.isArray(checkpoint.failures) ? checkpoint.failures : []) {
    if (failure?.hashName) failuresMap.set(normalizeName(failure.hashName), failure);
  }

  let queue = universe.filter((item) => item.marketable !== false);

  if (args.types?.length) {
    const allowed = new Set(args.types);
    queue = queue.filter((item) => allowed.has(String(item.category || "").toLowerCase()));
  }

  if (args.only) {
    const onlyKey = normalizeName(args.only);
    queue = queue.filter((item) => normalizeName(item.hashName) === onlyKey);
    if (!queue.length) {
      throw new Error(`Item not found for --only: ${args.only}`);
    }
  }

  if (args.resume && !args.force) {
    queue = queue.filter((item) => !completed.has(normalizeName(item.hashName)));
  }

  queue = queue.slice(0, args.limit);

  console.log(`[steam-market-timeseries] universe=${universe.length}`);
  console.log(`[steam-market-timeseries] queued=${queue.length}`);
  console.log(`[steam-market-timeseries] delay=${args.delayMs}ms`);
  console.log(`[steam-market-timeseries] output=${OUTPUT_PATH}`);

  let processed = 0;

  for (const item of queue) {
    processed += 1;
    const key = normalizeName(item.hashName);

    console.log(
      `[${processed}/${queue.length}] fetching ${item.hashName} | category=${item.category} | source=${item.sourceFile}`
    );

    try {
      const market = await fetchSteamMarket(item.hashName, { includeOrderbook: false });
      const outputItem = toOutputItem(item, market);

      existingMap.set(key, outputItem);
      completed.add(key);
      failuresMap.delete(key);

      saveOutput([...existingMap.values()], [...failuresMap.values()]);
      saveCheckpoint({
        updatedAt: new Date().toISOString(),
        completed: [...completed].sort(),
        failures: [...failuresMap.values()],
      });

      console.log(
        `[ok] ${item.hashName} | history=${outputItem.history.length} | latest=${outputItem.summary.latestPriceEur ?? "n/a"}`
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error(`[fail] ${item.hashName} | ${message}`);

      failuresMap.set(key, toFailure(item, error));

      saveOutput([...existingMap.values()], [...failuresMap.values()]);
      saveCheckpoint({
        updatedAt: new Date().toISOString(),
        completed: [...completed].sort(),
        failures: [...failuresMap.values()],
      });
    }

    if (processed < queue.length) {
      await sleep(args.delayMs);
    }
  }

  saveOutput([...existingMap.values()], [...failuresMap.values()]);
  saveCheckpoint({
    updatedAt: new Date().toISOString(),
    completed: [...completed].sort(),
    failures: [...failuresMap.values()],
  });

  console.log(`[done] wrote ${OUTPUT_PATH}`);
  console.log(`[done] items=${existingMap.size} failures=${failuresMap.size}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});