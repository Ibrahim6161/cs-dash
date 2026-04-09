const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function getArg(name, fallback = null, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanText(value) {
  return String(value || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(value) {
  const cleaned = cleanText(value).replace(/^from\s+/i, "");
  const match = cleaned.match(/€\s*([0-9.,]+)/i) || cleaned.match(/([0-9.,]+)/);
  if (!match) return null;
  const raw = match[1].trim();
  let normalized = raw;

  if (raw.includes(",") && raw.includes(".")) {
    normalized = raw.lastIndexOf(",") > raw.lastIndexOf(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (raw.includes(",")) {
    normalized = raw.replace(/\./g, "").replace(",", ".");
  }

  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric * 100) / 100 : null;
}

function parseCount(value) {
  const digits = cleanText(value).replace(/[^\d]/g, "");
  if (!digits) return null;
  const numeric = Number.parseInt(digits, 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function loadCasesMap(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const cases = Array.isArray(raw?.cases) ? raw.cases : [];
    const map = new Map();

    for (const entry of cases) {
      const caseName = cleanText(entry?.case || entry?.name);
      if (!caseName) continue;
      map.set(normalizeName(caseName), caseName);
    }

    return map.size ? map : null;
  } catch {
    return null;
  }
}

async function scrapeSkinBaronCards(page) {
  await page.waitForSelector("sb-offer-card .offer-card", { timeout: 30000 });
  await page.waitForTimeout(1500);

  return page.evaluate(() => {
    return [...document.querySelectorAll("sb-offer-card .offer-card")].map((card) => {
      const text = (selector) => {
        const element = card.querySelector(selector);
        return element ? (element.textContent || "").replace(/\s+/g, " ").trim() : "";
      };

      const href = card.getAttribute("href") || card.querySelector("a[href]")?.getAttribute("href") || null;
      const image = card.querySelector("img")?.getAttribute("src") || null;

      return {
        name: text(".lName.big") || text(".lName.small"),
        collection: text(".exteriorName"),
        availabilityText: text(".availability-wrapper"),
        suggestedText: text(".price.suggested-price"),
        priceText: text(".price.item"),
        href,
        image,
      };
    });
  });
}

async function run() {
  const outFile = getArg("--out", "pricempire_prices_eur.json");
  const casesFile = getArg("--cases", "cases.json");
  const headless = getArg("--headless", "1") !== "0";
  const slowMo = Number.parseInt(getArg("--slowmo", "0"), 10) || 0;
  const limit = Number.parseInt(getArg("--limit", "80"), 10) || 80;
  const url = getArg("--url", "https://skinbaron.de/en/csgo/Miscellaneous/Container?sort=PA");
  const caseUniverse = loadCasesMap(casesFile);
  const timestamp = new Date().toISOString();

  const browser = await chromium.launch({ headless, slowMo });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    viewport: { width: 1600, height: 1200 },
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    const cards = await scrapeSkinBaronCards(page);
    const providers = {
      skinbaron: {
        key: "skinbaron",
        name: "SkinBaron",
        logo: null,
        country: "DE",
        type: "marketplace",
      },
    };
    const map = {};
    const errors = [];

    for (const card of cards.slice(0, limit)) {
      const rawName = cleanText(card.name);
      if (!rawName) continue;

      const normalized = normalizeName(rawName);
      const canonicalName = caseUniverse?.get(normalized) || rawName;
      if (caseUniverse && !caseUniverse.has(normalized)) continue;

      const value = parseMoney(card.priceText || card.suggestedText);
      if (value == null) {
        errors.push({
          name: canonicalName,
          url: card.href ? `https://skinbaron.de${card.href}` : url,
          reason: `PRICE_PARSE_FAILED:${card.priceText || card.suggestedText || "missing"}`,
        });
        continue;
      }

      map[canonicalName] = [
        {
          providerKey: "skinbaron",
          providerName: "SkinBaron",
          value,
          count: parseCount(card.availabilityText),
          updatedAt: timestamp,
          lastCheckedAt: timestamp,
          sourceCurrency: "EUR",
          url: card.href ? `https://skinbaron.de${card.href}` : url,
          image: card.image || null,
          collection: cleanText(card.collection) || null,
        },
      ];
    }

    const payload = {
      meta: {
        timestamp,
        source: "SkinBaron direct",
        currency: "EUR",
        page_url: url,
        limit,
        scraped: Object.keys(map).length,
        providers: 1,
        errors: errors.length,
      },
      providers,
      map,
      errors,
    };

    ensureDir(outFile);
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");

    if (!Object.keys(map).length) {
      throw new Error("NO_SKINBARON_PRICES_SCRAPED");
    }

    console.log(`Done. Parsed ${Object.keys(map).length} SkinBaron prices.`);
    console.log(`Output -> ${outFile}`);
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error("FATAL:", error && error.stack ? error.stack : String(error));
  process.exit(1);
});
