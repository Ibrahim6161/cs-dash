const { getArg, runProviderScrape } = require("./lib/pricempire-provider-scraper.cjs");

const OUT_FILE = getArg("--out", "csmoney_prices_eur.json");
const CASES_FILE = getArg("--cases", "cases.json");
const HEADLESS = getArg("--headless", "1") !== "0";
const SLOWMO = Number.parseInt(getArg("--slowmo", "0"), 10) || 0;
const PAGE = Number.parseInt(getArg("--page", "1"), 10) || 1;
const LIMIT = Number.parseInt(getArg("--limit", "50"), 10) || 50;

runProviderScrape({
  outFile: OUT_FILE,
  casesFile: CASES_FILE,
  page: PAGE,
  limit: LIMIT,
  providerLabel: "CS.MONEY",
  providerKeys: ["csmoneym", "csmoney"],
  targetCurrency: "EUR",
}).catch((error) => {
  console.error("FATAL:", error && error.stack ? error.stack : String(error));
  process.exit(1);
});
