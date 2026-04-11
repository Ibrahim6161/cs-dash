const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.cwd();
const DEFAULT_CASES_FILE = path.join(ROOT, "cases.json");
const DEFAULT_OUT_FILE = path.join(ROOT, "case_details.json");
const DEFAULT_SHOTS_DIR = path.join(ROOT, "shots");

function buildCsstonksCaseUrl(name) {
  return `https://csstonks.com/case/${encodeURIComponent(name)}`;
}

function parseArgs(argv) {
  const args = {
    casesFile: DEFAULT_CASES_FILE,
    outFile: DEFAULT_OUT_FILE,
    shotsDir: DEFAULT_SHOTS_DIR,
    headless: true,
    slowMo: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--cases" && argv[i + 1]) {
      args.casesFile = path.resolve(ROOT, argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === "--out" && argv[i + 1]) {
      args.outFile = path.resolve(ROOT, argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === "--shots" && argv[i + 1]) {
      args.shotsDir = path.resolve(ROOT, argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === "--headless") {
      args.headless = true;
      continue;
    }

    if (arg === "--no-headless") {
      args.headless = false;
      continue;
    }

    if (arg === "--slowmo" && argv[i + 1]) {
      args.slowMo = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
    }
  }

  return args;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFlexibleNumber(value) {
  if (value == null) return null;

  let s = cleanText(value);
  if (!s) return null;

  s = s.replace(/[$€£%]/g, "").replace(/\s/g, "");

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastDot > lastComma) {
      // 1,234.56
      s = s.replace(/,/g, "");
    } else {
      // 1.234,56
      s = s.replace(/\./g, "").replace(/,/g, ".");
    }
  } else if (hasComma) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      // 12,34
      s = s.replace(",", ".");
    } else {
      // 1,234
      s = s.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = s.split(".");
    if (parts.length > 2) {
      // 1.234.567
      s = s.replace(/\./g, "");
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function slugifyCaseName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\//g, " ")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseRemaining(text) {
  const match = cleanText(text).match(/CURRENT REMAINING SUPPLY\s*([0-9.,]+)/i);
  return parseFlexibleNumber(match?.[1]);
}

function parseDelta(text) {
  const t = cleanText(text);
  if (!t) return { value: null, percent: null };

  const percent = (() => {
    const m = t.match(/\(([+-]?\d+(?:[.,]\d+)?)%\)/);
    return m ? parseFlexibleNumber(m[1]) : null;
  })();

  const monthMatch = t.match(/\b(1|6|12)\s+months?\b/i);
  const monthValue = monthMatch ? parseFlexibleNumber(monthMatch[1]) : null;

  const rawNumbers = [...t.matchAll(/([+-]?\d[\d.,]*)/g)]
    .map((m) => parseFlexibleNumber(m[1]))
    .filter((v) => v != null);

  let value = null;
  for (const num of rawNumbers) {
    if (monthValue != null && num === monthValue) continue;
    if (percent != null && num === percent) continue;
    value = num;
    break;
  }

  return { value, percent };
}

function parsePriceMarketCap(text) {
  const t = cleanText(text);

  const allNums = [...t.matchAll(/[$€£]?\s*([+-]?\d[\d.,]*)/g)]
    .map((m) => parseFlexibleNumber(m[1]))
    .filter((v) => v != null);

  if (allNums.length < 2) {
    return { priceUSD: null, marketCapUSD: null };
  }

  return {
    priceUSD: allNums[0],
    marketCapUSD: allNums[1],
  };
}

function parseExtinction(text) {
  const t = cleanText(text);

  const months =
    t.match(/~\s*([0-9]+(?:[.,][0-9]+)?)\s*months?/i)?.[1] ??
    t.match(/([0-9]+(?:[.,][0-9]+)?)\s*months?/i)?.[1] ??
    null;

  const date =
    t.match(/Approx\.?\s*date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i)?.[1] ??
    t.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/)?.[1] ??
    null;

  return {
    months: months != null ? parseFlexibleNumber(months) : null,
    approxDate: date || null,
  };
}

function classifyCardText(text) {
  const t = cleanText(text).toLowerCase();

  if (t.includes("current remaining supply")) return "current";

  if (
    (t.includes("delta") || t.includes("Δ") || t.includes("month")) &&
    (t.includes("1 month") || t.includes("1 months"))
  ) return "delta1m";

  if (
    (t.includes("delta") || t.includes("Δ") || t.includes("month")) &&
    (t.includes("6 month") || t.includes("6 months"))
  ) return "delta6m";

  if (
    (t.includes("delta") || t.includes("Δ") || t.includes("month")) &&
    (t.includes("12 month") || t.includes("12 months"))
  ) return "delta12m";

  if (t.includes("market cap")) return "market";
  if (t.includes("extinction")) return "extinction";

  return null;
}

async function getStatCards(page) {
  const selectors = [
    ".stat-card",
    "[class*='stat-card']",
    ".grid .card",
    ".grid > div",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count >= 4) {
      const texts = [];
      for (let i = 0; i < count; i += 1) {
        texts.push((await locator.nth(i).textContent().catch(() => "")) || "");
      }
      if (texts.some((t) => cleanText(t).toLowerCase().includes("current remaining supply"))) {
        return texts;
      }
    }
  }

  return [];
}

async function getPageText(page) {
  try {
    return await page.evaluate(() =>
      (document.body?.innerText || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
  } catch {
    return "";
  }
}


async function scrapeCaseDetails(browser, caseRecord, shotsDir) {
  const name = caseRecord.case || caseRecord.name;
  const url = caseRecord.url || buildCsstonksCaseUrl(name);
  const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    const cardTexts = await getStatCards(page);

    const cardMap = {
      current: null,
      delta1m: null,
      delta6m: null,
      delta12m: null,
      market: null,
      extinction: null,
    };

    for (const text of cardTexts) {
      const type = classifyCardText(text);
      if (type && !cardMap[type]) {
        cardMap[type] = text;
      }
    }

const pageText = await getPageText(page);

const remaining = parseRemaining(cardMap.current || pageText);
const delta1m = parseDelta(cardMap.delta1m || pageText);
const delta6m = parseDelta(cardMap.delta6m || pageText);
const delta12m = parseDelta(cardMap.delta12m || pageText);
const market = parsePriceMarketCap(cardMap.market || pageText);

let ext = parseExtinction(cardMap.extinction || "");
if (ext.months == null && ext.approxDate == null) {
  ext = parseExtinction(pageText);
}

    const pagePath = path.join(shotsDir, `page-${slugifyCaseName(name)}.png`);

    fs.mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: pagePath, fullPage: true });

    return {
      case: name,
      url,
      totals: {
        remaining,
        dropped: caseRecord.totals?.dropped ?? null,
        unboxed: caseRecord.totals?.unboxed ?? null,
        price: market.priceUSD,
        marketCap: market.marketCapUSD,
      },
      pageCards: {
        currentRemainingSupply: remaining,
        priceUSD: market.priceUSD,
        marketCapUSD: market.marketCapUSD,
        delta1m,
        delta6m,
        delta12m,
        extinction: ext,
      },
      screenshots: {
        mode: "page",
        chart: caseRecord.screenshots?.chart || null,
        page: path.basename(pagePath),
      },
      rawCards: cardMap,
pageExtinctionText: cleanText(cardMap.extinction || pageText),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = readJson(args.casesFile);
  const records = Array.isArray(payload?.cases) ? payload.cases : [];

  if (!records.length) {
    throw new Error(`No cases found in ${args.casesFile}`);
  }

  const browser = await chromium.launch({
    headless: args.headless,
    slowMo: args.slowMo,
  });

  const results = [];
  const failures = [];

  try {
    for (const record of records) {
      const name = record.case || record.name;
      if (!name) continue;

      try {
        console.log(`Scraping ${name}`);
        results.push(await scrapeCaseDetails(browser, record, args.shotsDir));
      } catch (error) {
        failures.push({ case: name, error: error.message || String(error) });
        results.push({
          case: name,
          url: record.url,
          totals: record.totals || {},
          pageCards: record.pageCards || {},
          screenshots: record.screenshots || {},
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const out = {
    timestamp: new Date().toISOString(),
    source: args.casesFile,
    cases: results,
    failures,
  };

  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(args.outFile, JSON.stringify(out, null, 2), "utf8");
  console.log(`Saved ${results.length} case detail records to ${args.outFile}`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});