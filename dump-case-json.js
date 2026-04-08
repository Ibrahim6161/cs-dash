const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

function deepFindSeries(obj) {
  const hits = [];

  const walk = (x, p = "") => {
    if (x == null) return;

    // arrays that look like time series
    if (Array.isArray(x)) {
      if (x.length >= 6) {
        const numCount = x.filter(v => typeof v === "number").length;
        const strCount = x.filter(v => typeof v === "string").length;
        if (numCount / x.length > 0.8 || strCount / x.length > 0.8) {
          hits.push({ path: p || "(root)", sample: x.slice(0, 8) });
        }
      }
      // still recurse a bit
      for (let i = 0; i < Math.min(x.length, 30); i++) walk(x[i], `${p}[${i}]`);
      return;
    }

    if (typeof x === "object") {
      for (const k of Object.keys(x)) {
        walk(x[k], p ? `${p}.${k}` : k);
      }
    }
  };

  walk(obj);
  return hits;
}

(async () => {
  const outDir = path.join(__dirname, "dump");
  fs.mkdirSync(outDir, { recursive: true });

  const caseName = "Winter Offensive Weapon Case";
  const url = "https://csstonks.com/case/" + encodeURIComponent(caseName);

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 1) Capture EVERYTHING via in-page monkeypatch (works even if content-type is wrong)
  await page.addInitScript(() => {
    window.__CAPTURED_BODIES__ = [];

    // fetch patch
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const clone = res.clone();
        const text = await clone.text();
        window.__CAPTURED_BODIES__.push({
          kind: "fetch",
          url: String(res.url || ""),
          status: res.status,
          body: text
        });
      } catch {}
      return res;
    };

    // XHR patch
    const OrigXHR = window.XMLHttpRequest;
    function XHRProxy() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      xhr.open = function(method, url, ...rest) {
        xhr.__url = url;
        xhr.__method = method;
        return origOpen.call(xhr, method, url, ...rest);
      };
      xhr.addEventListener("load", () => {
        try {
          const body = xhr.responseText;
          window.__CAPTURED_BODIES__.push({
            kind: "xhr",
            url: String(xhr.__url || ""),
            status: xhr.status,
            body: body
          });
        } catch {}
      });
      return xhr;
    }
    window.XMLHttpRequest = XHRProxy;
  });

  console.log("Opening:", url);
  await page.goto(url, { waitUntil: "networkidle" });

  // Give it time to render / request data
  await page.waitForTimeout(7000);

  const captured = await page.evaluate(() => window.__CAPTURED_BODIES__ || []);
  fs.writeFileSync(path.join(__dirname, "captured-raw.json"), JSON.stringify(captured, null, 2), "utf8");

  console.log("Captured responses:", captured.length);

  // 2) Save anything that looks like it contains chart series keywords
  const keywordHits = [];
  for (let i = 0; i < captured.length; i++) {
    const b = captured[i]?.body || "";
    if (!b || b.length < 30) continue;

    const low = b.toLowerCase();
    const looksChartish =
      low.includes("remaining") ||
      low.includes("supply") ||
      low.includes("drops") ||
      low.includes("unbox") ||
      low.includes("price");

    if (!looksChartish) continue;

    const file = path.join(outDir, `hit-${String(keywordHits.length + 1).padStart(3, "0")}.txt`);
    fs.writeFileSync(file, b, "utf8");

    keywordHits.push({
      idx: i,
      url: captured[i].url,
      status: captured[i].status,
      kind: captured[i].kind,
      file: path.basename(file),
      size: b.length
    });
  }

  fs.writeFileSync(path.join(__dirname, "hits-index.json"), JSON.stringify(keywordHits, null, 2), "utf8");

  console.log("Keyword hits saved:", keywordHits.length);
  if (keywordHits.length) {
    console.log("See: .\\dump\\hit-*.txt and hits-index.json");
  }

  // 3) Bonus: try parse JSON from each body and find time-series arrays
  const seriesReport = [];
  for (let i = 0; i < captured.length; i++) {
    const b = captured[i]?.body || "";
    if (!b || b.length < 30) continue;

    const trimmed = b.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) continue;

    try {
      const json = JSON.parse(trimmed);
      const series = deepFindSeries(json);
      if (series.length) {
        seriesReport.push({
          idx: i,
          url: captured[i].url,
          kind: captured[i].kind,
          status: captured[i].status,
          seriesCount: series.length,
          top: series.slice(0, 12)
        });
      }
    } catch {}
  }

  fs.writeFileSync(path.join(__dirname, "series-report.json"), JSON.stringify(seriesReport, null, 2), "utf8");
  console.log("Series report entries:", seriesReport.length);
  console.log("✅ Wrote: captured-raw.json, hits-index.json, series-report.json");

  await browser.close();
})();
