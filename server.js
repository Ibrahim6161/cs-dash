const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { DashboardService } = require("./lib/dashboard-service");

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "127.0.0.1";

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
  const target = decoded === "/" ? "/index.html" : decoded;
  const absolutePath = path.resolve(ROOT, "." + target);
  if (!absolutePath.startsWith(ROOT)) {
    throw new Error("Forbidden path.");
  }
  return absolutePath;
}

async function start() {
  const service = new DashboardService(ROOT);

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
