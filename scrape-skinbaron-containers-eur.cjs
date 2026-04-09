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

function classifyItem(name) {
  const lower = cleanText(name).toLowerCase();
  if (/\bsouvenir\b/.test(lower)) return "souvenir";
  if (/\bcapsule\b|\bautograph\b|\brmr\b/.test(lower)) return "capsule";
  if (/\bpin\b/.test(lower)) return "pins";
  if (/\bcase\b/.test(lower)) return "case";
  return "container";
}

async function scrapeCards(page) {
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
  const headless = getArg("--headless", "1") !== "0";
  const slowMo = Number.parseInt(getArg("--slowmo", "0"), 10) || 0;
  const limit = Number.parseInt(getArg("--limit", "500"), 10) || 500;
  const maxPages = Number.parseInt(getArg("--max-pages", "12"), 10) || 12;
  const baseUrl = getArg("--url", "https://skinbaron.de/en/csgo/Miscellaneous/Container?sort=PA");
  const timestamp = new Date().toISOString();

  const browser = await chromium.launch({ headless, slowMo });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    viewport: { width: 1600, height: 1200 },
  });

  try {
    const providers = {
      skinbaron: {
        key: "skinbaron",
        name: "SkinBaron",
        logo: null,
        country: "DE",
        type: "marketplace",
      },
    };
    const deduped = new Map();
    const errors = [];
    const pages = [];

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const connector = baseUrl.includes("?") ? "&" : "?";
      const pageUrl = `${baseUrl}${connector}page=${pageNumber}`;
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(500);
      const cards = await scrapeCards(page).catch(() => []);
      pages.push({ page: pageNumber, url: pageUrl, cards: cards.length });
      console.log(`SkinBaron page ${pageNumber}: ${cards.length} card(s)`);

      if (!cards.length) break;

      for (const card of cards) {
        const name = cleanText(card.name);
        if (!name) continue;

        const value = parseMoney(card.priceText || card.suggestedText);
        if (value == null) {
          errors.push({
            name,
            url: card.href ? `https://skinbaron.de${card.href}` : pageUrl,
            reason: `PRICE_PARSE_FAILED:${card.priceText || card.suggestedText || "missing"}`,
          });
          continue;
        }

        const key = normalizeName(name);
        const next = {
          providerKey: "skinbaron",
          providerName: "SkinBaron",
          value,
          count: parseCount(card.availabilityText),
          updatedAt: timestamp,
          lastCheckedAt: timestamp,
          sourceCurrency: "EUR",
          url: card.href ? `https://skinbaron.de${card.href}` : pageUrl,
          image: card.image || null,
          collection: cleanText(card.collection) || null,
          category: classifyItem(name),
          page: pageNumber,
        };

        const current = deduped.get(key);
        if (!current || next.value < current.prices[0].value) {
          deduped.set(key, { name, prices: [next] });
        }
      }

      if (deduped.size >= limit || cards.length < 60) break;
    }

    const map = {};
    for (const entry of [...deduped.values()].slice(0, limit)) {
      map[entry.name] = entry.prices;
    }

    const payload = {
      meta: {
        timestamp,
        source: "SkinBaron direct",
        currency: "EUR",
        page_url: baseUrl,
        scraped: Object.keys(map).length,
        providers: 1,
        errors: errors.length,
        pages,
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

    console.log(`Done. Parsed ${Object.keys(map).length} SkinBaron items.`);
    console.log(`Output -> ${outFile}`);
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error("FATAL:", error && error.stack ? error.stack : String(error));
  process.exit(1);
});
