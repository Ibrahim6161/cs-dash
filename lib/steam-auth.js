const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";

function createSessionStore() {
  const sessions = new Map();

  function gc() {
    const now = Date.now();
    for (const [key, value] of sessions.entries()) {
      if (!value || (value.expiresAt && value.expiresAt <= now)) {
        sessions.delete(key);
      }
    }
  }

  return {
    create(data, ttlMs = 1000 * 60 * 60 * 24 * 14) {
      gc();
      const id = crypto.randomBytes(24).toString("hex");
      sessions.set(id, {
        ...data,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
      });
      return id;
    },
    get(id) {
      gc();
      return id ? sessions.get(id) || null : null;
    },
    delete(id) {
      if (id) sessions.delete(id);
    },
  };
}

function parseCookies(headerValue) {
  const cookies = {};
  const source = String(headerValue || "");
  if (!source) return cookies;

  for (const part of source.split(/;\s*/)) {
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function inferBaseUrl(req, fallbackHost, fallbackPort) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || `${fallbackHost}:${fallbackPort}`;
  const proto = req.headers["x-forwarded-proto"] || (String(host).includes("localhost") || String(host).startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

function buildSteamLoginUrl(returnTo) {
  const url = new URL(STEAM_OPENID_ENDPOINT);
  url.searchParams.set("openid.ns", OPENID_NS);
  url.searchParams.set("openid.mode", "checkid_setup");
  url.searchParams.set("openid.return_to", returnTo);
  url.searchParams.set("openid.realm", new URL(returnTo).origin + "/");
  url.searchParams.set("openid.identity", IDENTIFIER_SELECT);
  url.searchParams.set("openid.claimed_id", IDENTIFIER_SELECT);
  return url.toString();
}

function requestText(url, method = "GET", headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        accept: "*/*",
        ...headers,
      },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk.toString();
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode || 0,
          body: data,
          headers: response.headers || {},
        });
      });
    });

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`Request timed out for ${url}`));
    });
    if (body) request.write(body);
    request.end();
  });
}

async function verifySteamAssertion(fullUrl) {
  const url = new URL(fullUrl);
  const params = new URLSearchParams(url.search);
  params.set("openid.mode", "check_authentication");

  const response = await requestText(
    STEAM_OPENID_ENDPOINT,
    "POST",
    { "content-type": "application/x-www-form-urlencoded" },
    params.toString()
  );

  if (response.statusCode !== 200) {
    throw new Error(`Steam auth verify failed (${response.statusCode}).`);
  }

  const body = response.body || "";
  if (!/\bis_valid\s*:\s*true\b/i.test(body)) {
    throw new Error("Steam login verification failed.");
  }

  const claimedId = params.get("openid.claimed_id") || "";
  const match = claimedId.match(/\/id\/(\d{17})$|\/profiles\/(\d{17})$/);
  const steamId = match ? (match[1] || match[2]) : null;
  if (!steamId) {
    throw new Error("Steam login did not return a valid SteamID.");
  }

  return steamId;
}

async function fetchSteamProfile(steamId) {
  const response = await requestText(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
  if (response.statusCode !== 200) {
    throw new Error(`Steam profile fetch failed (${response.statusCode}).`);
  }

  const body = response.body || "";
  const readTag = (tag) => {
    const match = body.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match ? (match[1] || match[2] || "").trim() : null;
  };

  return {
    steamId,
    personaName: readTag("steamID") || `Steam ${steamId}`,
    profileUrl: readTag("profileurl") || `https://steamcommunity.com/profiles/${steamId}/`,
    avatar: readTag("avatarFull") || readTag("avatarMedium") || readTag("avatarIcon") || null,
  };
}

module.exports = {
  buildSteamLoginUrl,
  createSessionStore,
  fetchSteamProfile,
  inferBaseUrl,
  parseCookies,
  serializeCookie,
  verifySteamAssertion,
};
