const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { DashboardService } = require("./lib/dashboard-service");
const { fetchSteamMarket } = require("./lib/steam-market");
const {
  fetchSteamInventory,
  groupInventoryItems,
  summarizeInventory,
} = require("./lib/steam-inventory");
const {
  normalizeSteamProfileQuery,
  resolvePublicSteamProfile,
} = require("./lib/steam-public-profile");
const {
  createSteamDebugLogger,
  serializeError,
} = require("./lib/steam-debug-log");
const {
  createSteamPriceIndex,
  lookupSteamPrice,
} = require("./lib/steam-price-index");

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "127.0.0.1";
const STEAM_DEBUG_PATH = path.join(ROOT, "steam_inventory_debug.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function writeSteamDebugFile(payload) {
  fs.writeFileSync(STEAM_DEBUG_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function readSteamDebugFile() {
  if (!fs.existsSync(STEAM_DEBUG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(STEAM_DEBUG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function resolveStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const target = decoded === "/" ? "/dashboard-v2.html" : decoded;
  const absolutePath = path.resolve(ROOT, "." + target);
  if (!absolutePath.startsWith(ROOT)) {
    throw new Error("Forbidden path.");
  }
  return absolutePath;
}

function createStaticInventoryValuationLookup(priceIndex) {
  return (inventoryItem) => {
    const match = lookupSteamPrice(priceIndex, inventoryItem);

    if (!match) {
      return {
        matched: false,
        source: null,
        unitPriceEur: null,
        sellListings: null,
        listingUrl: inventoryItem.marketable
          ? `https://steamcommunity.com/market/listings/730/${encodeURIComponent(inventoryItem.marketHashName)}`
          : null,
        iconUrl: null,
        priceUpdatedAt: null,
      };
    }

    return {
      matched: match.steamPriceEur != null,
      source: match.steamPriceEur != null ? "steam-static-cache" : null,
      unitPriceEur: match.steamPriceEur,
      sellListings: match.sellListings,
      listingUrl:
        match.listingUrl ||
        (inventoryItem.marketable
          ? `https://steamcommunity.com/market/listings/730/${encodeURIComponent(inventoryItem.marketHashName)}`
          : null),
      iconUrl: match.iconUrl || null,
      priceUpdatedAt: priceIndex?.meta?.builtAt || null,
    };
  };
}

async function start() {
  const service = new DashboardService(ROOT);
  const steamInventoryCache = new Map();
  const debugLog = createSteamDebugLogger(ROOT);
  let steamPriceIndex = createSteamPriceIndex(ROOT);

  if (process.argv.includes("--refresh-once")) {
    await service.initialize({ autoStart: false });
    try {
      await service.triggerRefresh("cli");
      while (service.getStatus().running) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const status = service.getStatus();
      if (status.state === "error") {
        console.error(status.lastError || "Refresh failed.");
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error && error.message ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  await service.initialize({ autoStart: true });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

      if (url.pathname === "/api/dashboard" && req.method === "GET") {
        sendJson(res, 200, service.getDashboard());
        return;
      }

      if (url.pathname === "/api/steam/public-inventory" && req.method === "POST") {
        debugLog.reset();

        const requestStartedAt = Date.now();
        const body = await readBody(req);
        const rawQuery = String(body.query || "").trim();
        const normalizedQuery = normalizeSteamProfileQuery(rawQuery);

        debugLog.write("request_start", {
          rawQuery,
          normalizedQuery,
          forceRefresh: body.refresh === true,
          ip: req.socket?.remoteAddress || null,
          userAgent: req.headers["user-agent"] || null,
        });

        if (!rawQuery) {
          debugLog.write("request_invalid", {
            reason: "empty_query",
          });

          sendJson(res, 400, {
            ok: false,
            error: "Enter a Steam profile URL, vanity URL, or SteamID64.",
            code: "STEAM_QUERY_REQUIRED",
          });
          return;
        }

        let profile;
        try {
          debugLog.write("profile_resolve_start", { rawQuery, normalizedQuery });
          profile = await resolvePublicSteamProfile(rawQuery);
          debugLog.write("profile_resolve_success", { profile });
        } catch (error) {
          debugLog.write("profile_resolve_failed", {
            error: serializeError(error),
          });

          sendJson(res, 400, {
            ok: false,
            error: error?.message || "Could not resolve Steam profile.",
            code: error?.code || "STEAM_PROFILE_RESOLVE_FAILED",
            debugLogPath: debugLog.path,
            debug: error?.debug || null,
          });
          return;
        }

        const forceRefresh = body.refresh === true;
        const cacheKey = profile.steamId;
        const cached = steamInventoryCache.get(cacheKey);

        if (!forceRefresh && cached && Date.now() - cached.cachedAt < 1000 * 60 * 3) {
          debugLog.write("cache_hit", {
            steamId: profile.steamId,
            ageMs: Date.now() - cached.cachedAt,
          });

          sendJson(res, 200, {
            ok: true,
            ...cached.payload,
            cached: true,
            debugLogPath: debugLog.path,
          });
          return;
        }

        try {
          if (forceRefresh) {
            steamPriceIndex = createSteamPriceIndex(ROOT);
            debugLog.write("steam_price_index_reloaded", {
              builtAt: steamPriceIndex?.meta?.builtAt || null,
              counts: steamPriceIndex?.meta?.counts || null,
              files: steamPriceIndex?.meta?.files || null,
            });
          }

          debugLog.write("inventory_fetch_start", {
            steamId: profile.steamId,
          });

          const inventoryRaw = await fetchSteamInventory(profile.steamId);

          debugLog.write("inventory_fetch_success", {
            steamId: profile.steamId,
            assetCount: Array.isArray(inventoryRaw.assets) ? inventoryRaw.assets.length : 0,
            descriptionCount:
              inventoryRaw.descriptions instanceof Map ? inventoryRaw.descriptions.size : 0,
            inventoryDebug: inventoryRaw.debug || null,
          });

          debugLog.write("group_items_start", {
            steamId: profile.steamId,
            valuationSource: "steam-static-cache",
            priceIndexMeta: steamPriceIndex?.meta || null,
          });

          const items = groupInventoryItems(
            inventoryRaw,
            createStaticInventoryValuationLookup(steamPriceIndex)
          );

          debugLog.write("group_items_success", {
            steamId: profile.steamId,
            groupedItems: items.length,
            matchedItems: items.filter((item) => item.matched).length,
            pricedItems: items.filter((item) => item.unitPriceEur != null).length,
          });

          debugLog.write("summarize_start", {
            steamId: profile.steamId,
          });

          const payload = summarizeInventory(profile, items);

          debugLog.write("summarize_success", {
            steamId: profile.steamId,
            totals: payload.totals,
          });

          const responsePayload = {
            ...payload,
            query: rawQuery,
            normalizedQuery,
            steamId: profile.steamId,
            cached: false,
            pricing: {
              mode: "steam-static-scrape",
              updatedAt: steamPriceIndex?.meta?.builtAt || null,
              files: steamPriceIndex?.meta?.files || null,
              counts: steamPriceIndex?.meta?.counts || null,
            },
            debugLogPath: debugLog.path,
          };

          steamInventoryCache.set(cacheKey, {
            cachedAt: Date.now(),
            payload: responsePayload,
          });

          writeSteamDebugFile({
            ok: true,
            savedAt: new Date().toISOString(),
            elapsedMs: Date.now() - requestStartedAt,
            query: rawQuery,
            normalizedQuery,
            steamId: profile.steamId,
            profile,
            raw: {
              assetCount: Array.isArray(inventoryRaw.assets) ? inventoryRaw.assets.length : 0,
              descriptionCount:
                inventoryRaw.descriptions instanceof Map
                  ? inventoryRaw.descriptions.size
                  : 0,
              debug: inventoryRaw.debug || null,
            },
            pricing: responsePayload.pricing,
            payload: responsePayload,
            debugLogPath: debugLog.path,
          });

          debugLog.write("request_success", {
            steamId: profile.steamId,
            elapsedMs: Date.now() - requestStartedAt,
          });

          sendJson(res, 200, { ok: true, ...responsePayload });
        } catch (error) {
          const code = error?.code || "STEAM_INVENTORY_ERROR";
          const statusCode = code === "STEAM_INVENTORY_PRIVATE" ? 403 : 502;

          debugLog.write("request_failed", {
            steamId: profile?.steamId || null,
            elapsedMs: Date.now() - requestStartedAt,
            code,
            error: serializeError(error),
          });

          writeSteamDebugFile({
            ok: false,
            savedAt: new Date().toISOString(),
            elapsedMs: Date.now() - requestStartedAt,
            query: rawQuery,
            normalizedQuery,
            steamId: profile?.steamId || null,
            profile: profile || null,
            error: error?.message || String(error),
            code,
            debug: error?.debug || null,
            debugLogPath: debugLog.path,
          });

          sendJson(res, statusCode, {
            ok: false,
            error: error?.message || String(error),
            code,
            steamId: profile?.steamId || null,
            profile: profile || null,
            debugLogPath: debugLog.path,
            debug: error?.debug || null,
          });
        }
        return;
      }

      if (url.pathname === "/api/steam/inventory-debug" && req.method === "GET") {
        const debugFile = readSteamDebugFile();
        if (!debugFile) {
          sendJson(res, 404, { ok: false, error: "No Steam inventory debug file found yet." });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          debug: debugFile,
          path: path.basename(STEAM_DEBUG_PATH),
        });
        return;
      }

      if (url.pathname === "/api/status" && req.method === "GET") {
        sendJson(res, 200, service.getStatus());
        return;
      }

      if (url.pathname === "/api/config" && req.method === "GET") {
        sendJson(res, 200, service.getConfig());
        return;
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        const patch = await readBody(req);
        const config = await service.updateConfig(patch);
        sendJson(res, 200, { ok: true, config, status: service.getStatus() });
        return;
      }

      if (url.pathname === "/api/refresh" && req.method === "POST") {
        try {
          await service.triggerRefresh("manual");
          steamPriceIndex = createSteamPriceIndex(ROOT);
          sendJson(res, 202, {
            ok: true,
            status: service.getStatus(),
            pricing: {
              mode: "steam-static-scrape",
              updatedAt: steamPriceIndex?.meta?.builtAt || null,
              files: steamPriceIndex?.meta?.files || null,
              counts: steamPriceIndex?.meta?.counts || null,
            },
          });
        } catch (error) {
          const statusCode = error && error.code === "REFRESH_IN_PROGRESS" ? 409 : 500;
          sendJson(res, statusCode, {
            ok: false,
            error: error && error.message ? error.message : String(error),
            status: service.getStatus(),
          });
        }
        return;
      }

      if (url.pathname === "/api/item-market" && req.method === "GET") {
        const name = (url.searchParams.get("name") || "").trim();
        if (!name) {
          sendJson(res, 400, { ok: false, error: "Missing item name." });
          return;
        }
        try {
          const market = await fetchSteamMarket(name, { includeOrderbook: true });
          sendJson(res, 200, { ok: true, name, market });
        } catch (error) {
          sendJson(res, 502, {
            ok: false,
            error: error && error.message ? error.message : String(error),
          });
        }
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "Method not allowed." });
        return;
      }

      let filePath = resolveStaticPath(url.pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { error: `Not found: ${url.pathname}` });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const noCache = ext === ".html" || ext === ".js" || ext === ".css";
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": noCache ? "no-cache, no-store, must-revalidate" : "public, max-age=60",
      });

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      sendJson(res, 500, {
        error: error && error.message ? error.message : String(error),
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Dashboard server running at http://${HOST}:${PORT}`);
    console.log(`Steam debug log: ${path.join(ROOT, "steam_public_inventory_debug.log")}`);
  });
}

start().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});