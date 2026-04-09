const https = require("https");
const { URL } = require("url");

function requestText(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers || {},
          url,
        });
      });
    });

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`Request timed out for ${url}`));
    });
    request.end();
  });
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : null;
}

function normalizeSteamProfileQuery(input) {
  return String(input || "").trim();
}

function extractDirectSteamIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (!/steamcommunity\.com$/i.test(url.hostname)) return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "profiles" && /^[0-9]{17}$/.test(parts[1] || "")) {
      return parts[1];
    }
    return null;
  } catch {
    return null;
  }
}

function extractVanityFromUrl(value) {
  try {
    const url = new URL(value);
    if (!/steamcommunity\.com$/i.test(url.hostname)) return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "id" && parts[1]) {
      return parts[1];
    }
    return null;
  } catch {
    return null;
  }
}

function buildCandidateXmlUrls(rawQuery) {
  const query = normalizeSteamProfileQuery(rawQuery);
  const candidates = [];

  if (/^[0-9]{17}$/.test(query)) {
    candidates.push(`https://steamcommunity.com/profiles/${query}/?xml=1`);
    return candidates;
  }

  const directSteamId = extractDirectSteamIdFromUrl(query);
  if (directSteamId) {
    candidates.push(`https://steamcommunity.com/profiles/${directSteamId}/?xml=1`);
    return candidates;
  }

  const vanityFromUrl = extractVanityFromUrl(query);
  if (vanityFromUrl) {
    candidates.push(`https://steamcommunity.com/id/${vanityFromUrl}/?xml=1`);
    return candidates;
  }

  if (/^[a-zA-Z0-9_-]{2,64}$/.test(query)) {
    candidates.push(`https://steamcommunity.com/id/${query}/?xml=1`);
  }

  return candidates;
}

async function resolvePublicSteamProfile(rawQuery) {
  const candidateUrls = buildCandidateXmlUrls(rawQuery);

  if (!candidateUrls.length) {
    const error = new Error("Invalid Steam profile input. Use a Steam profile URL, vanity URL, or SteamID64.");
    error.code = "STEAM_PROFILE_INVALID_INPUT";
    throw error;
  }

  let lastBody = null;

  for (const url of candidateUrls) {
    const response = await requestText(url);
    lastBody = response.body;

    if (response.statusCode !== 200) {
      continue;
    }

    const steamId = extractTag(response.body, "steamID64");
    if (!steamId || !/^[0-9]{17}$/.test(steamId)) {
      continue;
    }

    const personaName = extractTag(response.body, "steamID");
    const profileUrl = extractTag(response.body, "profileurl") || `https://steamcommunity.com/profiles/${steamId}/`;
    const avatar = extractTag(response.body, "avatarFull") || extractTag(response.body, "avatarMedium") || extractTag(response.body, "avatarIcon");
    const visibilityState = extractTag(response.body, "visibilityState");
    const privacyState = extractTag(response.body, "privacyState");
    const headline = extractTag(response.body, "headline");
    const location = extractTag(response.body, "location");
    const memberSince = extractTag(response.body, "memberSince");
    const realName = extractTag(response.body, "realname");

    return {
      steamId,
      personaName: personaName || steamId,
      profileUrl,
      avatar: avatar || null,
      visibilityState: visibilityState != null ? Number(visibilityState) : null,
      privacyState: privacyState != null ? Number(privacyState) : null,
      headline: headline || null,
      location: location || null,
      memberSince: memberSince || null,
      realName: realName || null,
    };
  }

  const error = new Error("Could not resolve a public Steam profile from that input.");
  error.code = "STEAM_PROFILE_NOT_FOUND";
  error.debug = {
    query: rawQuery,
    candidates: candidateUrls,
    bodyPreview: String(lastBody || "").slice(0, 500),
  };
  throw error;
}

module.exports = {
  normalizeSteamProfileQuery,
  resolvePublicSteamProfile,
};