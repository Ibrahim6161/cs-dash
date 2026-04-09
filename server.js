const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { DashboardService } = require("./lib/dashboard-service");
const { fetchSteamMarket } = require("./lib/steam-market");
const {
  buildSteamLoginUrl,
  createSessionStore,
  fetchSteamProfile,
  inferBaseUrl,
  parseCookies,
  serializeCookie,
  verifySteamAssertion,
} = require("./lib/steam-auth");
const {
  enrichWithLivePrices,
  fetchSteamInventory,
  groupInventoryItems,
  summarizeInventory,
} = require("./lib/steam-inventory");

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "127.0.0.1";
const SESSION_COOKIE = "steam_portfolio_session";
const STEAM_DEBUG_PATH = path.join(ROOT, "steam_inventory_debug.json");
const STEAM_AUTH_INVENTORY_PATH = path.join(ROOT, "steam_inventory_auth.json");

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

function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
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

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadAuthenticatedInventoryFile() {
  const payload = readJsonFileSafe(STEAM_AUTH_INVENTORY_PATH);
  if (!payload || payload.ok !== true) return null;
  return {
    steamId: payload.steamId || null,
    profile: payload.profile || null,
    raw: {
      assets: Array.isArray(payload.assets) ? payload.assets : [],
      descriptions: new Map(
        (Array.isArray(payload.descriptions) ? payload.descriptions : []).map((entry) => [
          `${entry.classid}_${entry.instanceid}`,
          entry,
        ])
      ),
      debug: {
        fetchedAt: payload.fetchedAt || null,
        source: payload.source || "playwright-auth",
        meta: payload.meta || null,
      },
    },
  };
}

function serialiseInventoryRaw(raw) {
  const assets = Array.isArray(raw?.assets) ? raw.assets : [];
  const descriptions = raw?.descriptions instanceof Map ? [...raw.descriptions.values()] : [];
  return {
    assetCount: assets.length,
    descriptionCount: descriptions.length,
    sampleAssets: assets.slice(0, 8),
    sampleDescriptions: descriptions.slice(0, 8).map((entry) => ({
      classid: entry.classid,
      instanceid: entry.instanceid,
      market_hash_name: entry.market_hash_name,
      market_name: entry.market_name,
      name: entry.name,
      type: entry.type,
      tradable: entry.tradable,
      marketable: entry.marketable,
      commodity: entry.commodity,
    })),
    debug: raw?.debug || null,
  };
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

async function start() {
  const service = new DashboardService(ROOT);
  const sessions = createSessionStore();
  const steamInventoryCache = new Map();
  const livePriceCache = new Map();

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
      const cookies = parseCookies(req.headers.cookie || "");
      const sessionId = cookies[SESSION_COOKIE] || null;
      const session = sessions.get(sessionId);

      const getSteamAuthStatus = () => ({
        connected: !!session?.steamId,
        profile: session?.profile || null,
      });

      const getDashboardIndex = () => {
        const dashboard = service.getDashboard().dashboard;
        const byKey = new Map();
        const byName = new Map();
        for (const item of dashboard.items || []) {
          byKey.set(item.key, item);
          byName.set(String(item.name || "").trim().toLowerCase(), item);
        }
        return { byKey, byName };
      };

      const buildValuationLookup = (dashboardIndex) => (inventoryItem) => {
        const dashboardItem = dashboardIndex.byKey.get(inventoryItem.key)
          || dashboardIndex.byName.get(String(inventoryItem.name || "").trim().toLowerCase())
          || null;
        const unitPriceEur = dashboardItem?.price?.steamPriceEur
          ?? dashboardItem?.price?.steamMedianEur
          ?? null;

        return {
          matched: unitPriceEur != null,
          source: unitPriceEur != null ? "dashboard-steam-cache" : null,
          unitPriceEur,
          listingUrl: dashboardItem?.urls?.steam || null,
          dashboardKey: dashboardItem?.key || null,
          dashboardItem: dashboardItem ? {
            key: dashboardItem.key,
            name: dashboardItem.name,
            category: dashboardItem.category,
            grade: dashboardItem.grade,
            scores: dashboardItem.scores,
          } : null,
        };
      };

      if (url.pathname === "/api/dashboard" && req.method === "GET") {
        sendJson(res, 200, service.getDashboard());
        return;
      }

      if (url.pathname === "/api/steam/auth/status" && req.method === "GET") {
        sendJson(res, 200, { ok: true, ...getSteamAuthStatus() });
        return;
      }

      if (url.pathname === "/auth/steam/login" && req.method === "GET") {
        const baseUrl = inferBaseUrl(req, HOST, PORT);
        const returnTo = new URL("/auth/steam/return", baseUrl);
        returnTo.searchParams.set("state", crypto.randomBytes(12).toString("hex"));
        redirect(res, buildSteamLoginUrl(returnTo.toString()));
        return;
      }

      if (url.pathname === "/auth/steam/return" && req.method === "GET") {
        try {
          const baseUrl = inferBaseUrl(req, HOST, PORT);
          const fullUrl = new URL(req.url || "/", baseUrl).toString();
          const steamId = await verifySteamAssertion(fullUrl);
          const profile = await fetchSteamProfile(steamId);
          const newSessionId = sessions.create({ steamId, profile });
          redirect(res, "/dashboard-v2.html?steam=connected", {
            "Set-Cookie": serializeCookie(SESSION_COOKIE, newSessionId, {
              httpOnly: true,
              sameSite: "Lax",
              path: "/",
              maxAge: 60 * 60 * 24 * 14,
            }),
          });
        } catch (error) {
          redirect(res, `/dashboard-v2.html?steam_error=${encodeURIComponent(error && error.message ? error.message : String(error))}`);
        }
        return;
      }

      if (url.pathname === "/api/steam/logout" && req.method === "POST") {
        sessions.delete(sessionId);
        res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: 0,
        }));
        sendJson(res, 200, { ok: true, connected: false, profile: null });
        return;
      }

      if (url.pathname === "/api/steam/inventory" && req.method === "GET") {
        if (!session?.steamId) {
          sendJson(res, 401, { ok: false, error: "Steam account is not connected." });
          return;
        }

        const authInventory = loadAuthenticatedInventoryFile();
        if (authInventory && authInventory.steamId === session.steamId && url.searchParams.get("source") !== "live") {
          const items = groupInventoryItems(authInventory.raw, buildValuationLookup(getDashboardIndex()));
          await enrichWithLivePrices(items, livePriceCache, 24);
          const payload = summarizeInventory(authInventory.profile || session.profile, items);
          sendJson(res, 200, { ok: true, ...payload, cached: true, source: "file-auth" });
          return;
        }

        if (url.searchParams.get("source") === "file") {
          const debugFile = readSteamDebugFile();
          if (!debugFile) {
            sendJson(res, 404, { ok: false, error: "No local Steam inventory debug file found yet." });
            return;
          }
          if (debugFile.payload) {
            sendJson(res, 200, { ok: true, ...debugFile.payload, cached: true, source: "file" });
            return;
          }
          sendJson(res, 502, {
            ok: false,
            error: debugFile.error || "Debug file contains no successful payload.",
            code: debugFile.code || "STEAM_INVENTORY_DEBUG_ERROR",
            debugFile,
          });
          return;
        }

        const forceRefresh = url.searchParams.get("refresh") === "1";
        const cached = steamInventoryCache.get(session.steamId);
        if (!forceRefresh && cached && (Date.now() - cached.cachedAt) < 1000 * 60 * 3) {
          sendJson(res, 200, { ok: true, ...cached.payload, cached: true });
          return;
        }

        try {
          const inventoryRaw = await fetchSteamInventory(session.steamId);
          const items = groupInventoryItems(inventoryRaw, buildValuationLookup(getDashboardIndex()));
          await enrichWithLivePrices(items, livePriceCache, 24);
          const payload = summarizeInventory(session.profile, items);
          writeSteamDebugFile({
            ok: true,
            savedAt: new Date().toISOString(),
            steamId: session.steamId,
            profile: session.profile || null,
            raw: serialiseInventoryRaw(inventoryRaw),
            payload,
          });
          steamInventoryCache.set(session.steamId, { cachedAt: Date.now(), payload });
          sendJson(res, 200, { ok: true, ...payload, cached: false });
        } catch (error) {
          const code = error?.code || "STEAM_INVENTORY_ERROR";
          const statusCode = code === "STEAM_INVENTORY_PRIVATE" ? 403 : 502;
          writeSteamDebugFile({
            ok: false,
            savedAt: new Date().toISOString(),
            steamId: session.steamId,
            profile: session.profile || null,
            error: error?.message || String(error),
            code,
            debug: error?.debug || null,
          });
          sendJson(res, statusCode, { ok: false, error: error?.message || String(error), code });
        }
        return;
      }

      if (url.pathname === "/api/steam/inventory-debug" && req.method === "GET") {
        const debugFile = readSteamDebugFile();
        if (!debugFile) {
          sendJson(res, 404, { ok: false, error: "No Steam inventory debug file found yet." });
          return;
        }
        sendJson(res, 200, { ok: true, debug: debugFile, path: path.basename(STEAM_DEBUG_PATH) });
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
          sendJson(res, 202, { ok: true, status: service.getStatus() });
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
  });
}

start().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
