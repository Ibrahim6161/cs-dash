/* ==============================
 * scrape-case-details.js (FULL)
 * Usage:
 *   node scrape-case-details.js --cases cases.json --out case_details.json --shots shots --headless
 * ============================== */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return null;
  return v;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

// ---------- parsing helpers ----------
function norm(s) {
  return String(s || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumberLoose(txt) {
  // Accept: 15.046.476  |  $2,506,970  |  -117.226  |  323,480  |  0.58  |  —
  if (txt == null) return null;
  let s = norm(txt);
  if (!s || s === "—" || s === "-" || /n\/a/i.test(s)) return null;

  // remove currency + words
  s = s.replace(/[\$€]/g, "").replace(/,/g, ",").trim();

  // normalize unicode minus
  s = s.replace(/[−–]/g, "-");

  // if it contains '%' keep only number part elsewhere
  s = s.replace(/%/g, "").trim();

  // kill spaces
  s = s.replace(/\s+/g, "");

  // Thousands styles:
  // EU: 15.046.476 -> 15046476
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    const n = Number(s.replace(/\./g, ""));
    return Number.isFinite(n) ? n : null;
  }

  // US: 2,506,970 -> 2506970
  if (/^-?\d{1,3}(,\d{3})+$/.test(s)) {
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  // If both comma and dot exist:
  // - if commas look like thousands separators => remove commas
  // - else try best-effort
  if (s.includes(",") && s.includes(".")) {
    // Most common: $2,506,970 or 1,234.56
    // If commas are thousands: remove commas
    if (/\d,\d{3}/.test(s)) s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    // Could be decimal comma, but on csstonks numbers are usually integer with EU dots.
    // Still: treat comma as thousands if pattern fits, else decimal.
    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else s = s.replace(",", ".");
  }

  // remove remaining stray separators for ints like 323.480 already handled; but keep decimals like 0.58
  // If multiple dots -> remove all dots
  const dotCount = (s.match(/\./g) || []).length;
  if (dotCount > 1) s = s.replace(/\./g, "");

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDeltaBlock(blockText) {
  // Expects something like:
  // "-5.659 (-1.75%)"  OR  "-117.226 (-36.24%)"
  const t = norm(blockText);

  // find percent in (...) if present
  const mPct = t.match(/\(([-+−–]?\s*[\d.,]+)\s*%\)/);
  const pct = mPct ? parseNumberLoose(mPct[1]) : null;

  // value: take first "big number" token (with signs)
  // prefer something like -5.659, -70.975, 410.801
  const mVal = t.match(/[-+−–]?\s*[\d][\d.,]*/);
  const val = mVal ? parseNumberLoose(mVal[0]) : null;

  return { value: val, percent: pct };
}

function safeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, "_");
}

function toCaseUrl(name) {
  return "https://csstonks.com/case/" + encodeURIComponent(name);
}

// ---------- DOM extract ----------
async function extractCaseDetails(page) {
  // Wait for the stat cards area
  await page.waitForTimeout(800);

  // The page is React-ish; we select by visible headings.
  const result = await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

    const pickCard = (re) => {
      const cards = Array.from(document.querySelectorAll("div"));
      // heuristic: stat cards contain a small heading + a big number
      for (const c of cards) {
        const txt = norm(c.innerText);
        if (!txt) continue;
        if (re.test(txt)) return c;
      }
      return null;
    };

    const getCardText = (re) => {
      const c = pickCard(re);
      return c ? norm(c.innerText) : null;
    };

    const getH1 = () => {
      const h = document.querySelector("h1");
      return h ? norm(h.innerText) : null;
    };

    const title = getH1();

    // Grab the entire page text blocks for specific cards
    const remainingText = getCardText(/current remaining supply/i);
    const priceText = getCardText(/price\s*&\s*market cap/i);
    const extinctionText = getCardText(/extinction projection/i);

    // Deltas: match "1 month", "6 months", "12 months"
    const d1Text = getCardText(/\b1 month\b/i);
    const d6Text = getCardText(/\b6 months\b/i);
    const d12Text = getCardText(/\b12 months\b/i);

    // Dropped / Unboxed might exist as labels on this page; if not, we’ll rely on cases.json
    // (Most of your current pipeline already has dropped/unboxed totals.)
    return {
      title,
      blocks: {
        remainingText,
        priceText,
        extinctionText,
        d1Text,
        d6Text,
        d12Text,
      }
    };
  });

  return result;
}

// ---------- chart screenshot (big & readable) ----------
async function screenshotChartOrPage(page, caseName, shotsDir) {
  const base = safeFileName(caseName);
  const chartPath = path.join(shotsDir, `chart-${base}.png`);
  const pagePath = path.join(shotsDir, `page-${base}.png`);

  // Try to locate SUPPLY OVER TIME section and screenshot that container
  const supplyHeader = page.locator("h2", { hasText: /SUPPLY OVER TIME/i }).first();

  try {
    if (await supplyHeader.count()) {
      // Go to it and screenshot parent section
      await supplyHeader.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);

      // Best-effort: screenshot the nearest big container containing the canvas
      const section = supplyHeader.locator("xpath=ancestor::*[self::section or self::div][.//canvas]").first();
      if (await section.count()) {
        await section.screenshot({ path: chartPath });
        return { chartPath, pagePath: null, mode: "chart-section" };
      }

      // Fallback: screenshot canvas parent
      const canvas = page.locator("canvas").first();
      if (await canvas.count()) {
        const canvasWrap = canvas.locator("xpath=ancestor::div[1]").first();
        await canvasWrap.screenshot({ path: chartPath });
        return { chartPath, pagePath: null, mode: "canvas-wrap" };
      }
    }
  } catch (_) {
    // ignore and fallback
  }

  // Fallback full page screenshot
  await page.screenshot({ path: pagePath, fullPage: true });
  return { chartPath: null, pagePath, mode: "fullpage" };
}

// ---------- main ----------
async function main() {
  const casesFile = argVal("--cases");
  const outFile = argVal("--out") || "case_details.json";
  const shotsDir = argVal("--shots") || "shots";
  const headless = hasFlag("--headless");

  if (!casesFile) {
    throw new Error("Missing --cases");
  }
  if (!fs.existsSync(casesFile)) {
    throw new Error("Cases file not found: " + casesFile);
  }
  if (!fs.existsSync(shotsDir)) {
    fs.mkdirSync(shotsDir, { recursive: true });
  }

  const input = JSON.parse(fs.readFileSync(casesFile, "utf8"));
  const cases = Array.isArray(input.cases) ? input.cases : [];

  const browser = await chromium.launch({ headless: !!headless });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const out = {
    timestamp: new Date().toISOString(),
    source: path.resolve(casesFile),
    cases: []
  };

  for (const c of cases) {
    const name = c.case;
    const url = toCaseUrl(name);

    console.log(`▶ Scraping details: ${name}`);

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    // Extract text blocks
    const extracted = await extractCaseDetails(page);

    // Parse numbers from blocks (robust)
    const remainingBlock = extracted.blocks.remainingText || "";
    // Remaining card text contains label + value; grab last “number-like” token
    const remMatch = remainingBlock.match(/current remaining supply\s+([-\d.,]+)/i);
    const remainingSupply = remMatch ? parseNumberLoose(remMatch[1]) : null;

    const priceBlock = extracted.blocks.priceText || "";
    const priceMatch = priceBlock.match(/\$?\s*([-\d.,]+)\s*$/m); // first big number often is price line; but safer below
    // Better: parse first $x.xx in block
    const priceDollar = (priceBlock.match(/\$([-\d.,]+)/) || [])[1];
    const price = priceDollar ? parseNumberLoose(priceDollar) : null;

    // Market cap line: "Market Cap: $2,506,970"
    const mcMatch = priceBlock.match(/market cap:\s*\$([-\d.,]+)/i);
    const marketCap = mcMatch ? parseNumberLoose(mcMatch[1]) : null;

    const extinctionBlock = extracted.blocks.extinctionText || "";
    // "~28.6 months" and "Approx. date: 2028-02-17"
    const monthsMatch = extinctionBlock.match(/~\s*([-\d.,]+)\s*months/i);
    const extinctionMonths = monthsMatch ? parseNumberLoose(monthsMatch[1]) : null;

    const dateMatch = extinctionBlock.match(/approx\.\s*date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    const extinctionDate = dateMatch ? dateMatch[1] : null;

    const d1 = parseDeltaBlock(extracted.blocks.d1Text || "");
    const d6 = parseDeltaBlock(extracted.blocks.d6Text || "");
    const d12 = parseDeltaBlock(extracted.blocks.d12Text || "");

    // Screenshot chart area big & readable
    const shots = await screenshotChartOrPage(page, name, shotsDir);

    out.cases.push({
      case: name,
      url,
      // keep your table totals from cases.json too:
      totals: {
        remaining: c.remaining ?? null,
        dropped: c.dropped ?? null,
        unboxed: c.unboxed ?? null,
        price: c.price ?? null,
        marketCap: c.marketCap ?? null
      },
      pageCards: {
        currentRemainingSupply: remainingSupply,
        priceUSD: price,
        marketCapUSD: marketCap,
        delta1m: d1,   // {value, percent}
        delta6m: d6,
        delta12m: d12,
        extinction: {
          months: extinctionMonths,
          approxDate: extinctionDate
        }
      },
      screenshots: {
        mode: shots.mode,
        chart: shots.chartPath ? path.basename(shots.chartPath) : null,
        page: shots.pagePath ? path.basename(shots.pagePath) : null
      }
    });

    await page.waitForTimeout(200);
  }

  await browser.close();

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");
  console.log("✅ Saved:", outFile);
}

main().catch((e) => {
  console.error("FATAL:", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
