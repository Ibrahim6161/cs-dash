const https = require("https");
const { normalizeName } = require("./dashboard-analytics-v2");

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        accept: "application/json,text/plain,*/*",
        ...headers,
      },
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk.toString();
      });
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers || {},
            body: JSON.parse(body || "{}"),
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`Request timed out for ${url}`));
    });
  });
}

async function fetchInventoryPage(steamId, startAssetId = null) {
  const startParam = startAssetId ? `&start_assetid=${encodeURIComponent(startAssetId)}` : "";
  const url = `https://steamcommunity.com/inventory/${encodeURIComponent(steamId)}/730/2?l=english&count=2000${startParam}`;
  return requestJson(url);
}

async function fetchSteamInventory(steamId) {
  const descriptions = new Map();
  const assets = [];
  let startAssetId = null;

  for (let page = 0; page < 6; page += 1) {
    const response = await fetchInventoryPage(steamId, startAssetId);
    const payload = response.body || {};
    if (response.statusCode !== 200) {
      throw new Error(payload?.error || `Steam inventory failed (${response.statusCode}).`);
    }
    if (!Array.isArray(payload.assets) || !Array.isArray(payload.descriptions)) {
      throw new Error("Steam inventory is private or unavailable.");
    }

    for (const description of payload.descriptions) {
      const key = `${description.classid || ""}_${description.instanceid || ""}`;
      descriptions.set(key, description);
    }
    assets.push(...payload.assets);

    if (!payload.more_items || !payload.last_assetid) break;
    startAssetId = payload.last_assetid;
  }

  return { assets, descriptions };
}

function toItemUrl(marketHashName) {
  return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`;
}

function aggregateInventory(inventory, dashboardItems = []) {
  const dashboardByKey = new Map(
    (Array.isArray(dashboardItems) ? dashboardItems : []).map((item) => [normalizeName(item.name), item])
  );
  const grouped = new Map();

  for (const asset of inventory.assets || []) {
    const lookupKey = `${asset.classid || ""}_${asset.instanceid || ""}`;
    const description = inventory.descriptions.get(lookupKey);
    if (!description) continue;

    const marketHashName = description.market_hash_name || description.name;
    const normalized = normalizeName(marketHashName);
    const quantity = Number(asset.amount || 1);
    const existing = grouped.get(normalized) || {
      key: normalized,
      name: marketHashName,
      iconUrl: description.icon_url
        ? `https://community.akamai.steamstatic.com/economy/image/${description.icon_url}/96fx96f`
        : null,
      color: description.name_color || null,
      type: description.type || null,
      marketable: Number(description.marketable) === 1,
      tradable: Number(description.tradable) === 1,
      commodity: Number(description.commodity) === 1,
      quantity: 0,
      marketUrl: marketHashName ? toItemUrl(marketHashName) : null,
      tracked: false,
      category: null,
      steamPriceEur: null,
      skinbaronPriceEur: null,
      score: null,
      totalSteamValueEur: null,
    };

    existing.quantity += Number.isFinite(quantity) ? quantity : 1;

    const tracked = dashboardByKey.get(normalized);
    if (tracked) {
      existing.tracked = true;
      existing.category = tracked.category?.label || null;
      existing.score = tracked.scores?.total ?? null;
      existing.steamPriceEur = tracked.price?.steamPriceEur ?? null;
      existing.skinbaronPriceEur = tracked.price?.skinbaronFloorEur ?? null;
      existing.totalSteamValueEur = existing.steamPriceEur != null
        ? existing.steamPriceEur * existing.quantity
        : null;
    }

    grouped.set(normalized, existing);
  }

  const items = [...grouped.values()].sort((left, right) => {
    if (left.tracked !== right.tracked) return left.tracked ? -1 : 1;
    if ((right.totalSteamValueEur || 0) !== (left.totalSteamValueEur || 0)) {
      return (right.totalSteamValueEur || 0) - (left.totalSteamValueEur || 0);
    }
    if (right.quantity !== left.quantity) return right.quantity - left.quantity;
    return left.name.localeCompare(right.name);
  });

  const trackedItems = items.filter((item) => item.tracked);
  const marketableItems = items.filter((item) => item.marketable);

  return {
    items,
    trackedItems,
    marketableItems,
    summary: {
      totalUniqueItems: items.length,
      totalTrackedItems: trackedItems.length,
      totalUnits: items.reduce((sum, item) => sum + (item.quantity || 0), 0),
      marketableUniqueItems: marketableItems.length,
      trackedSteamValueEur: trackedItems.reduce((sum, item) => sum + (item.totalSteamValueEur || 0), 0),
    },
  };
}

module.exports = {
  aggregateInventory,
  fetchSteamInventory,
};
