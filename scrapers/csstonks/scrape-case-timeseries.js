// scrape-case-timeseries.js
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

function normalizeCaseName(s) {
  return String(s || "").trim().toLowerCase();
}

function isNumericLike(v) {
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)));
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sortDateStrings(arr) {
  return [...arr].sort((a, b) => String(a).localeCompare(String(b)));
}

function makeEmptySeries() {
  return {
    dates: [],
    remaining: [],
    drops: [],
    unboxings: [],
    price: [],
  };
}

function isGoodSeries(out) {
  return (
    Array.isArray(out?.dates) &&
    out.dates.length >= 12 &&
    (
      (Array.isArray(out.remaining) && out.remaining.length >= 12) ||
      (Array.isArray(out.drops) && out.drops.length >= 12) ||
      (Array.isArray(out.unboxings) && out.unboxings.length >= 12) ||
      (Array.isArray(out.price) && out.price.length >= 12)
    )
  );
}

function mapDatasetToField(label) {
  const l = String(label || "").toLowerCase();
  if (/(remain|remaining|supply|circulation|in circulation)/.test(l)) return "remaining";
  if (/(drop|dropped)/.test(l)) return "drops";
  if (/(unbox|unboxing|opened|opening)/.test(l)) return "unboxings";
  if (/(price|avg price|average price|value|median)/.test(l)) return "price";
  return null;
}

function extractChartLike(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const labels = obj.labels;
  const datasets = obj.datasets;

  if (!Array.isArray(labels) || labels.length < 12) return null;
  if (!Array.isArray(datasets) || datasets.length < 1) return null;

  const out = makeEmptySeries();
  out.dates = labels;

  for (const ds of datasets) {
    if (!ds || !Array.isArray(ds.data) || ds.data.length < 12) continue;
    const field = mapDatasetToField(ds.label);
    if (field) out[field] = ds.data;
  }

  if (isGoodSeries(out)) return out;

  const arrays = datasets
    .map((d) => d?.data)
    .filter((a) => Array.isArray(a) && a.length >= 12);

  if (arrays.length) {
    out.remaining = arrays[0] || [];
    out.drops = arrays[1] || [];
    out.unboxings = arrays[2] || [];
    out.price = arrays[3] || [];
  }

  return isGoodSeries(out) ? out : null;
}

function extractKeyBased(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const keys = Object.keys(obj);
  const findKey = (needles) =>
    keys.find((k) => needles.some((n) => k.toLowerCase().includes(n)));

  const kDates = findKey(["date", "dates", "month", "months", "label", "labels", "time", "x"]);
  const kRemaining = findKey(["remain", "remaining", "supply", "circulation"]);
  const kDrops = findKey(["drop"]);
  const kUnbox = findKey(["unbox", "open"]);
  const kPrice = findKey(["price", "value", "median"]);

  const dates = kDates ? obj[kDates] : null;
  if (!Array.isArray(dates) || dates.length < 12) return null;

  const out = makeEmptySeries();
  out.dates = dates;
  out.remaining = Array.isArray(obj[kRemaining]) ? obj[kRemaining] : [];
  out.drops = Array.isArray(obj[kDrops]) ? obj[kDrops] : [];
  out.unboxings = Array.isArray(obj[kUnbox]) ? obj[kUnbox] : [];
  out.price = Array.isArray(obj[kPrice]) ? obj[kPrice] : [];

  return isGoodSeries(out) ? out : null;
}

/**
 * Handles shapes like:
 * {
 *   "2014-01": 123,
 *   "2014-02": 456
 * }
 *
 * or
 *
 * {
 *   "2014-01": { unboxings: 123 },
 *   "2014-02": { unboxings: 456 }
 * }
 *
 * or
 *
 * {
 *   "2014-01": { value: 123, price: 1.2 }
 * }
 */
function extractMonthlyObject(inner) {
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;

  const keys = Object.keys(inner);
  if (keys.length < 12) return null;

  // Heuristic: month/date-like keys
  const dateishKeys = keys.filter((k) => /\d{4}[-/]\d{1,2}/.test(k) || /^\d{4}-\d{2}$/.test(k));
  const useKeys = dateishKeys.length >= 12 ? dateishKeys : keys;

  const dates = sortDateStrings(useKeys);
  if (dates.length < 12) return null;

  // Case 1: direct numeric values => assume unboxings
  if (dates.every((d) => isNumericLike(inner[d]))) {
    return {
      dates,
      remaining: [],
      drops: [],
      unboxings: dates.map((d) => toNumberOrNull(inner[d])),
      price: [],
    };
  }

  // Case 2: nested objects per month
  if (dates.every((d) => inner[d] && typeof inner[d] === "object" && !Array.isArray(inner[d]))) {
    const sample = inner[dates[0]];
    const sampleKeys = Object.keys(sample || {});
    const findNested = (needles) =>
      sampleKeys.find((k) => needles.some((n) => k.toLowerCase().includes(n)));

    const kRemaining = findNested(["remain", "remaining", "supply", "circulation"]);
    const kDrops = findNested(["drop"]);
    const kUnbox = findNested(["unbox", "open", "value", "count"]);
    const kPrice = findNested(["price", "median"]);

    const out = makeEmptySeries();
    out.dates = dates;
    out.remaining = kRemaining ? dates.map((d) => toNumberOrNull(inner[d][kRemaining])) : [];
    out.drops = kDrops ? dates.map((d) => toNumberOrNull(inner[d][kDrops])) : [];
    out.unboxings = kUnbox ? dates.map((d) => toNumberOrNull(inner[d][kUnbox])) : [];
    out.price = kPrice ? dates.map((d) => toNumberOrNull(inner[d][kPrice])) : [];

    return isGoodSeries(out) ? out : null;
  }

  return null;
}

/**
 * Handles shapes like:
 * [
 *   { month: "2014-01", value: 123 },
 *   { month: "2014-02", value: 456 }
 * ]
 */
function extractRowsArray(arr) {
  if (!Array.isArray(arr) || arr.length < 12) return null;
  const rows = arr.filter((r) => r && typeof r === "object" && !Array.isArray(r));
  if (rows.length < 12) return null;

  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const findKey = (needles) =>
    keys.find((k) => needles.some((n) => k.toLowerCase().includes(n)));

  const kDate = findKey(["date", "month", "time", "period", "label"]);
  if (!kDate) return null;

  const kRemaining = findKey(["remain", "remaining", "supply", "circulation"]);
  const kDrops = findKey(["drop"]);
  const kUnbox = findKey(["unbox", "open", "value", "count"]);
  const kPrice = findKey(["price", "median"]);

  const sorted = [...rows].sort((a, b) => String(a[kDate]).localeCompare(String(b[kDate])));
  const out = makeEmptySeries();
  out.dates = sorted.map((r) => r[kDate]);
  out.remaining = kRemaining ? sorted.map((r) => toNumberOrNull(r[kRemaining])) : [];
  out.drops = kDrops ? sorted.map((r) => toNumberOrNull(r[kDrops])) : [];
  out.unboxings = kUnbox ? sorted.map((r) => toNumberOrNull(r[kUnbox])) : [];
  out.price = kPrice ? sorted.map((r) => toNumberOrNull(r[kPrice])) : [];

  return isGoodSeries(out) ? out : null;
}

/**
 * Main fix:
 * case_unboxing_monthly.json has shape:
 * {
 *   "Winter Offensive Weapon Case": <inner-shape>,
 *   "Falchion Case": <inner-shape>,
 *   ...
 * }
 */
function extractFromCaseUnboxingMonthly(root, caseName) {
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;

  const targetKey = Object.keys(root).find(
    (k) => normalizeCaseName(k) === normalizeCaseName(caseName)
  );
  if (!targetKey) return null;

  const inner = root[targetKey];

  // 1) direct monthly object
  let found = extractMonthlyObject(inner);
  if (found) return found;

  // 2) rows array
  found = extractRowsArray(inner);
  if (found) return found;

  // 3) generic parsers
  found = extractChartLike(inner);
  if (found) return found;

  found = extractKeyBased(inner);
  if (found) return found;

  // 4) one level deeper
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    for (const v of Object.values(inner)) {
      found = extractMonthlyObject(v);
      if (found) return found;

      found = extractRowsArray(v);
      if (found) return found;

      found = extractChartLike(v);
      if (found) return found;

      found = extractKeyBased(v);
      if (found) return found;
    }
  }

  return null;
}

function extractFromAnyJson(data, caseName, url = "") {
  if (!data) return null;

  // Most important special-case first
  if (url.includes("case_unboxing_monthly.json")) {
    const special = extractFromCaseUnboxingMonthly(data, caseName);
    if (special) return special;
  }

  let found = extractChartLike(data);
  if (found) return found;

  found = extractKeyBased(data);
  if (found) return found;

  found = extractRowsArray(data);
  if (found) return found;

  if (typeof data === "object" && !Array.isArray(data)) {
    for (const v of Object.values(data)) {
      found = extractChartLike(v);
      if (found) return found;

      found = extractKeyBased(v);
      if (found) return found;

      found = extractRowsArray(v);
      if (found) return found;

      found = extractMonthlyObject(v);
      if (found) return found;
    }
  }

  return null;
}

async function clickChartToggles(page) {
  try {
    await page.evaluate(() => {
      const txt = (el) => (el?.textContent || "").trim().toLowerCase();

      for (const btn of Array.from(document.querySelectorAll("button"))) {
        const t = txt(btn);
        if (t === "all" || t === "max") btn.click();
      }

      for (const cb of Array.from(document.querySelectorAll('input[type="checkbox"]'))) {
        if (!cb.checked) cb.click();
      }
    });
  } catch {}
}

(async () => {
  if (!fs.existsSync(CASES_FILE)) {
    console.error(`Missing ${CASES_FILE}`);
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));
  const cases = (parsed.cases || []).map((x) => x.case).filter(Boolean);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });

  await context.addInitScript(() => {
    window.__CAPTURED_JSON__ = [];
    window.__CAPTURED_TEXT__ = [];

    const pushJson = (url, data) => {
      try {
        window.__CAPTURED_JSON__.push({ url, data });
      } catch {}
    };

    const pushText = (url, text) => {
      try {
        window.__CAPTURED_TEXT__.push({ url, text: String(text).slice(0, 200000) });
      } catch {}
    };

    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const clone = res.clone();
        const url = clone.url || String(args[0] || "");
        const ct = clone.headers.get("content-type") || "";
        const text = await clone.text();

        if (ct.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
          try {
            pushJson(url, JSON.parse(text));
          } catch {
            pushText(url, text);
          }
        }
      } catch {}
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__url = url;
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener("load", function() {
        try {
          const text = this.responseText;
          const url = this.__url || "";
          if (!text) return;

          const t = String(text).trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            try {
              pushJson(url, JSON.parse(t));
            } catch {
              pushText(url, t);
            }
          }
        } catch {}
      });

      return origSend.call(this, ...args);
    };
  });

  const out = {};
  const failures = [];

  for (const name of cases) {
    let page;
    try {
      console.log(`Scraping: ${name}`);

      page = await context.newPage();
      const url = "https://csstonks.com/case/" + encodeURIComponent(name);
      const safeName = name.replace(/[^a-z0-9]+/gi, "_");

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (page.isClosed()) throw new Error("Page closed after goto");

      await page.waitForTimeout(2500);
      await clickChartToggles(page);

      if (page.isClosed()) throw new Error("Page closed after toggle");
      await page.waitForTimeout(2500);

      const debug = await page.evaluate(() => {
        return {
          nextData: (() => {
            const el = document.querySelector("#__NEXT_DATA__");
            if (!el) return null;
            try {
              return JSON.parse(el.textContent || "");
            } catch {
              return null;
            }
          })(),
          capturedJson: window.__CAPTURED_JSON__ || [],
          capturedText: window.__CAPTURED_TEXT__ || [],
        };
      });

      const shapeSummary = debug.capturedJson.map((x) => ({
        url: x.url,
        isArray: Array.isArray(x.data),
        len: Array.isArray(x.data) ? x.data.length : undefined,
        keys: Array.isArray(x.data)
          ? Object.keys(x.data[0] || {})
          : Object.keys(x.data || {}).slice(0, 25),
      }));

      fs.writeFileSync(
        `debug-${safeName}.json`,
        JSON.stringify({ ...debug, shapeSummary }, null, 2),
        "utf8"
      );

      let found = null;

      if (debug.nextData) {
        found = extractFromAnyJson(debug.nextData, name, "__NEXT_DATA__");
      }

      if (!found) {
        for (const item of debug.capturedJson) {
          found = extractFromAnyJson(item.data, name, item.url);
          if (found) break;
        }
      }

      if (!found) {
        for (const item of debug.capturedText) {
          const parsedText = safeJsonParse(item.text);
          if (!parsedText) continue;
          found = extractFromAnyJson(parsedText, name, item.url);
          if (found) break;
        }
      }

      if (!found) {
        failures.push(name);
        console.log(`No timeseries found for ${name}`);
        await page.screenshot({ path: `debug-${safeName}.png`, fullPage: true }).catch(() => {});
      } else {
        out[name] = found;
        console.log(`OK: ${name} (${found.dates.length} points)`);
      }

      await page.close().catch(() => {});
    } catch (err) {
      failures.push(name);
      console.log(`FAIL: ${name} -> ${err.message}`);
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
    }
  }

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        out,
        failures,
      },
      null,
      2
    ),
    "utf8"
  );

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  console.log(`DONE -> ${OUT_FILE}`);
})();