// scrape-case-timeseries.js
// Node.js + Playwright scraper for csstonks.com case timeseries
// Strategy:
//  1) Parse embedded Next.js __NEXT_DATA__
//  2) Capture JSON responses (fetch/XHR / _next/data/*.json)
//  3) Extract timeseries from either:
//     - Chart.js-like shape: { labels: [...], datasets: [{label, data:[...]}...] }
//     - Key-based shape: { dates/month/... , remaining/supply , drops , unboxings , price }

const { chromium } = require("playwright");
const fs = require("fs");

const CASES_FILE = "cases.json";
const OUT_FILE = "case-timeseries.json";

function safeJsonParse(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function looksLikeSeriesObj(obj) {
  if (!obj || typeof obj !== "object") return false;

  let arrays = 0;
  const keys = [];

  const walk = (x) => {
    if (x == null) return;
    if (Array.isArray(x)) {
      if (x.length >= 12) arrays++;
      for (let i = 0; i < Math.min(x.length, 3); i++) walk(x[i]);
      return;
    }
    if (typeof x === "object") {
      for (const k of Object.keys(x)) {
        keys.push(k.toLowerCase());
        walk(x[k]);
      }
    }
  };
  walk(obj);

  const keyStr = keys.join(" ");

  // Timeseries / chart hints (Chart.js + domain hints)
  const hint =
    /labels|datasets|series|xaxis|chart|drop|unbox|remain|supply|price|month|date|time|label/.test(
      keyStr
    );

  return arrays >= 2 && hint;
}

function extractSeries(obj) {
  const pickKey = (o, needles) => {
    for (const k of Object.keys(o || {})) {
      const lk = k.toLowerCase();
      if (needles.some((n) => lk.includes(n))) return k;
    }
    return null;
  };

  const normalizeLabel = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const mapDatasetToField = (label) => {
    const l = normalizeLabel(label);
    if (/(remain|remaining|supply|in circulation|circulation)/.test(l))
      return "remaining";
    if (/(drop|dropped)/.test(l)) return "drops";
    if (/(unbox|unboxing|opened|openings)/.test(l)) return "unboxings";
    if (/(price|avg price|average price|median|value)/.test(l)) return "price";
    return null;
  };

  let best = null;

  const tryChartJs = (x) => {
    // Chart.js shape: { labels: [...], datasets: [{label, data:[...]}...] }
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;

    const labelsKey = Object.keys(x).find((k) => k.toLowerCase() === "labels");
    const datasetsKey = Object.keys(x).find(
      (k) => k.toLowerCase() === "datasets"
    );

    if (!labelsKey || !datasetsKey) return null;

    const labels = x[labelsKey];
    const datasets = x[datasetsKey];

    if (!Array.isArray(labels) || labels.length < 12) return null;
    if (!Array.isArray(datasets) || datasets.length < 2) return null;

    const out = {
      dates: labels,
      remaining: [],
      drops: [],
      unboxings: [],
      price: [],
    };

    // First pass: try map by label
    for (const ds of datasets) {
      if (!ds || typeof ds !== "object") continue;
      const data = ds.data;
      if (!Array.isArray(data) || data.length < 12) continue;

      const field = mapDatasetToField(ds.label);
      if (field) out[field] = data;
    }

    const populated =
      out.remaining.length >= 12 ||
      out.drops.length >= 12 ||
      out.unboxings.length >= 12 ||
      out.price.length >= 12;

    if (populated) return out;

    // Fallback: assign first datasets if labels didn't match
    const dataSetsOnly = datasets
      .map((ds) => (ds && Array.isArray(ds.data) ? ds.data : []))
      .filter((a) => a.length >= 12);

    if (dataSetsOnly.length >= 1) out.remaining = dataSetsOnly[0];
    if (dataSetsOnly.length >= 2) out.drops = dataSetsOnly[1];
    if (dataSetsOnly.length >= 3) out.unboxings = dataSetsOnly[2];
    if (dataSetsOnly.length >= 4) out.price = dataSetsOnly[3];

    const fallbackPopulated =
      out.remaining.length >= 12 ||
      out.drops.length >= 12 ||
      out.unboxings.length >= 12 ||
      out.price.length >= 12;

    return fallbackPopulated ? out : null;
  };

  const walk = (x) => {
    if (!x || typeof x !== "object") return;

    // 1) Chart.js attempt
    const cj = tryChartJs(x);
    if (cj) {
      best = cj;
      return;
    }

    // 2) Key-based attempt
    if (!Array.isArray(x)) {
      const kDates = pickKey(x, ["date", "month", "label", "x"]);
      const kRem = pickKey(x, ["remain", "supply"]);
      const kDrops = pickKey(x, ["drop"]);
      const kUnbox = pickKey(x, ["unbox"]);
      const kPrice = pickKey(x, ["price"]);

      const dates = kDates ? x[kDates] : null;
      const remaining = kRem ? x[kRem] : null;
      const drops = kDrops ? x[kDrops] : null;
      const unboxings = kUnbox ? x[kUnbox] : null;
      const price = kPrice ? x[kPrice] : null;

      const arrs = [dates, remaining, drops, unboxings, price].filter(
        (a) => Array.isArray(a) && a.length >= 12
      );

      if (Array.isArray(dates) && dates.length >= 12 && arrs.length >= 2) {
        best = {
          dates,
          remaining: Array.isArray(remaining) ? remaining : [],
          drops: Array.isArray(drops) ? drops : [],
          unboxings: Array.isArray(unboxings) ? unboxings : [],
          price: Array.isArray(price) ? price : [],
        };
        return;
      }
    }

    // Recurse
    if (Array.isArray(x)) {
      for (let i = 0; i < Math.min(x.length, 300); i++) {
        if (best) return;
        walk(x[i]);
      }
    } else {
      for (const k of Object.keys(x)) {
        if (best) return;
        walk(x[k]);
      }
    }
  };

  walk(obj);
  return best;
}

async function clickChartToggles(page) {
  await page
    .evaluate(() => {
      // Click "All" button if exists
      const btns = Array.from(document.querySelectorAll("button"));
      const allBtn = btns.find(
        (b) => (b.textContent || "").trim().toLowerCase() === "all"
      );
      if (allBtn) allBtn.click();

      // Find the "SUPPLY OVER TIME" section root
      const h = Array.from(document.querySelectorAll("h2,h3")).find((x) =>
        (x.textContent || "").toUpperCase().includes("SUPPLY OVER TIME")
      );
      const root = h?.parentElement || document;

      // Toggle all checkboxes ON
      const cbs = Array.from(root.querySelectorAll('input[type="checkbox"]'));
      cbs.forEach((cb) => {
        if (!cb.checked) cb.click();
      });
    })
    .catch(() => {});
}

(async () => {
  if (!fs.existsSync(CASES_FILE)) {
    console.error(`❌ Missing ${CASES_FILE} in current folder`);
    process.exit(1);
  }

  const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8")).cases.map(
    (x) => x.case
  );

  const browser = await chromium.launch({ headless: true });

  // Use a "real" UA to reduce headless differences
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  const out = {};
  const failures = [];

  // Capture URLs + JSON responses
  let netUrls = new Set();
  let jsonBodies = []; // { url, j }

  page.on("request", (req) => {
    try {
      netUrls.add(req.url());
    } catch {}
  });

  page.on("response", async (res) => {
    try {
      const url = res.url();
      const headers = await res.headers();
      const ct = (headers["content-type"] || "").toLowerCase();

      // only likely JSON
      const isJson =
        ct.includes("application/json") ||
        url.includes("/_next/data/") ||
        url.endsWith(".json");

      if (!isJson) return;

      // read as text, then parse
      const text = await res.text();
      const j = safeJsonParse(text);
      if (j) jsonBodies.push({ url, j });
    } catch {}
  });

  for (const name of cases) {
    console.log(`▶ Scraping: ${name}`);

    netUrls = new Set();
    jsonBodies = [];

    const url = "https://csstonks.com/case/" + encodeURIComponent(name);
    const safeName = name.replace(/[^a-z0-9]+/gi, "_");

    // Load fully
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // Ensure section exists (best-effort)
    await page
      .waitForSelector("h2:has-text('SUPPLY OVER TIME')", { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(800);

    // Click toggles
    await clickChartToggles(page);
    await page.waitForTimeout(2500);

    // Dump request URLs and JSON urls for debugging
    fs.writeFileSync(
      `net-urls-${safeName}.json`,
      JSON.stringify(Array.from(netUrls), null, 2),
      "utf8"
    );
    fs.writeFileSync(
      `json-urls-${safeName}.json`,
      JSON.stringify(jsonBodies.map((x) => x.url), null, 2),
      "utf8"
    );

    // 1) Try extract from __NEXT_DATA__
    let found = null;
    const nextData = await page.evaluate(() => {
      const el = document.querySelector("#__NEXT_DATA__");
      if (!el) return null;
      try {
        return JSON.parse(el.textContent || "");
      } catch {
        return null;
      }
    });

    if (nextData) {
      const series = extractSeries(nextData);
      if (series) found = series;
    }

    // 2) If not found, scan JSON responses (fast filter first)
    if (!found) {
      for (const item of jsonBodies) {
        if (!looksLikeSeriesObj(item.j)) continue;
        const series = extractSeries(item.j);
        if (series) {
          found = series;
          break;
        }
      }
    }

    // 3) If still not found, do a broader scan (slower but helpful)
    if (!found) {
      for (const item of jsonBodies) {
        const series = extractSeries(item.j);
        if (series) {
          found = series;
          break;
        }
      }
    }

    if (!found) {
      console.log(
        `❌ No timeseries found for ${name} (jsonBodies=${jsonBodies.length})`
      );
      failures.push(name);

      // Debug screenshot
      try {
        await page.screenshot({ path: `debug-${safeName}.png`, fullPage: true });
      } catch {}

      // Dump one full JSON body for inspection
      try {
        const pick =
          jsonBodies.find((x) => x.url.includes("/_next/data/")) ||
          jsonBodies[0] ||
          null;

        fs.writeFileSync(
          `json-full-first-${safeName}.json`,
          JSON.stringify(pick ? { url: pick.url, body: pick.j } : null, null, 2),
          "utf8"
        );
      } catch {}

      continue;
    }

    out[name] = found;
    console.log(
      `✔ OK: ${name} (dates=${found.dates.length}, jsonBodies=${jsonBodies.length})`
    );
  }

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), out, failures },
      null,
      2
    ),
    "utf8"
  );

  await browser.close();
  console.log(`✅ DONE -> ${OUT_FILE}`);
  if (failures.length) console.log(`⚠ Failures: ${failures.length}`);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
