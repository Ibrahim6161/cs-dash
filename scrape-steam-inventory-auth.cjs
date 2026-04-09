const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function boolFlag(flag, fallback = false) {
  return process.argv.includes(flag) ? true : fallback;
}

async function fetchInventoryInPage(page, steamId, appId, contextId, count) {
  return page.evaluate(async ({ steamId, appId, contextId, count }) => {
    const url = new URL(`https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}`);
    url.searchParams.set("l", "english");
    url.searchParams.set("count", String(count));

    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: {
        accept: "application/json,text/plain,*/*",
      },
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      url: url.toString(),
      payload,
      textPreview: String(text || "").slice(0, 500),
    };
  }, { steamId, appId, contextId, count });
}

async function main() {
  const steamId = argValue("--steamid");
  const outPath = path.resolve(process.cwd(), argValue("--out", "steam_inventory_auth.json"));
  const profileDir = path.resolve(process.cwd(), argValue("--profile-dir", ".steam-auth-profile"));
  const appId = Number(argValue("--appid", "730"));
  const contextId = Number(argValue("--contextid", "2"));
  const count = Number(argValue("--count", "2000"));
  const waitMs = Number(argValue("--wait", "180000"));
  const headless = boolFlag("--headless", false);

  if (!steamId) {
    throw new Error("Missing --steamid <steam64id>.");
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1400, height: 1000 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const inventoryUrl = `https://steamcommunity.com/profiles/${steamId}/inventory/`;
    await page.goto(inventoryUrl, { waitUntil: "domcontentloaded" });

    const startedAt = Date.now();
    let lastResult = null;

    while ((Date.now() - startedAt) < waitMs) {
      lastResult = await fetchInventoryInPage(page, steamId, appId, contextId, count);
      if (lastResult.ok && lastResult.payload && lastResult.payload.success === 1) {
        const payload = {
          ok: true,
          fetchedAt: new Date().toISOString(),
          steamId,
          profileUrl: inventoryUrl,
          appId,
          contextId,
          source: "playwright-auth",
          assets: lastResult.payload.assets || [],
          descriptions: lastResult.payload.descriptions || [],
          meta: {
            assetCount: Array.isArray(lastResult.payload.assets) ? lastResult.payload.assets.length : 0,
            descriptionCount: Array.isArray(lastResult.payload.descriptions) ? lastResult.payload.descriptions.length : 0,
          },
        };
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
        console.log(`Saved authenticated Steam inventory to ${outPath}`);
        return;
      }

      console.log(`Waiting for logged-in inventory access... status=${lastResult?.status || 0}`);
      await page.waitForTimeout(3000);
    }

    const failure = {
      ok: false,
      fetchedAt: new Date().toISOString(),
      steamId,
      profileUrl: inventoryUrl,
      appId,
      contextId,
      source: "playwright-auth",
      error: "Timed out waiting for authenticated Steam inventory access.",
      lastResult,
    };
    fs.writeFileSync(outPath, JSON.stringify(failure, null, 2), "utf8");
    throw new Error(`Timed out waiting for authenticated Steam inventory access. Debug saved to ${outPath}`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
