const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const HEADLESS = process.argv.includes("--headless");
const WAIT_MS = Number(getArg("--wait", 20000));
const URL = getArg("--url", "https://pricempire.com/app/trending/cases?page=1&sort=current&order=DESC");

async function snapshot(page, tag) {
  const png = path.join(process.cwd(), `probe_${tag}.png`);
  const html = path.join(process.cwd(), `probe_${tag}.html`);
  await page.screenshot({ path: png, fullPage: true }).catch(() => {});
  fs.writeFileSync(html, await page.content(), "utf8");
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: 0 });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: "en-US",
    storageState: fs.existsSync("storageState.json") ? "storageState.json" : undefined,
  });
  const page = await context.newPage();

  console.log(`Opening ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 70000 });

  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    const status = await page.evaluate(() => {
      const html = document.documentElement?.innerHTML || "";
      const body = document.body?.innerText || "";
      const title = document.title || "";
      const anchors = document.querySelectorAll('a[href*="/cs2-items/container/"]').length;
      const htmlMatches = (html.match(/\/cs2-items\/container\/[a-z0-9-]+/gi) || []).length;
      const hasChallenge = /challenge-platform|__CF\$cv\$params|cdn-cgi/i.test(html) || /just a moment|checking your browser/i.test(body);
      return {
        title,
        url: location.href,
        anchors,
        htmlMatches,
        hasChallenge,
        bodySample: body.slice(0, 200),
      };
    });

    console.log(JSON.stringify({ t: Math.round((Date.now() - started) / 1000), ...status }));
    if (status.anchors > 0 || status.htmlMatches > 0 || !status.hasChallenge) {
      break;
    }
    await page.waitForTimeout(2000);
  }

  await snapshot(page, "final");
  await context.close();
  await browser.close();
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
