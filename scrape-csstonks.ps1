# ==============================
# scrape-csstonks.ps1 (FINAL)
# ==============================

$ErrorActionPreference = "Stop"

$basePath = "C:\Users\Assassin61\Documents\CSGO"
$jsFile   = "$basePath\scrape-csstonks.js"
$outFile  = "$basePath\cases.json"

Set-Location $basePath

@'
const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const outFile = process.argv[2];
  if (!outFile) throw new Error("Missing output file");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto("https://csstonks.com/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table", { timeout: 60000 });
  await page.waitForTimeout(1000);

  // --------------------------------------------------
  // EXPLICITLY ENABLE:
  // "Hide cases with incomplete/low quality data"
  // --------------------------------------------------
  const hideCb = page.getByRole("checkbox", {
    name: /hide cases with incomplete|low quality/i
  }).first();

  if (await hideCb.count()) {
    if (!(await hideCb.isChecked())) {
      await hideCb.setChecked(true, { force: true });
      await page.waitForTimeout(1200);
    }
  }

  // Small scroll to stabilize rendering
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(120);
  }

  const data = await page.evaluate(() => {
    const parseNum = (txt) => {
      if (!txt) return null;
      let s = txt.replace(/\$/g, "").replace(/\s+/g, "").trim();
      if (!s || s === "—") return null;

      if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
      if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ""));

      if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
      if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");

      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    // Column order on csstonks:
    // 0 Case | 1 Lowest Supply | 2 Remaining | 3 Dropped | 4 Unboxed | 5 Price | 6 Market Cap
    const rows = Array.from(document.querySelectorAll("table tbody tr"));

    return rows.map(row => {
      const tds = Array.from(row.querySelectorAll("td"));
      if (tds.length < 7) return null;

      return {
        case: tds[0].innerText.trim(),
        remaining: parseNum(tds[2].innerText),
        dropped: parseNum(tds[3].innerText),
        unboxed: parseNum(tds[4].innerText),
        price: parseNum(tds[5].innerText),
        marketCap: parseNum(tds[6].innerText)
      };
    }).filter(Boolean);
  });

  fs.writeFileSync(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    cases: data
  }, null, 2));

  console.log("Saved", data.length, "cases (filtered)");
  await browser.close();
})();
'@ | Set-Content -Path $jsFile -Encoding UTF8

node "$jsFile" "$outFile"
