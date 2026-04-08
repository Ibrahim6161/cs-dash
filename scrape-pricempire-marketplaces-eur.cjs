const { getArg, runMarketplaceScrape } = require("./lib/pricempire-provider-scraper.cjs");

const OUT_FILE = getArg("--out", "pricempire_prices_eur.json");
const CASES_FILE = getArg("--cases", "cases.json");
const PAGE = Number.parseInt(getArg("--page", "1"), 10) || 1;
const LIMIT = Number.parseInt(getArg("--limit", "50"), 10) || 50;

runMarketplaceScrape({
  outFile: OUT_FILE,
  casesFile: CASES_FILE,
  page: PAGE,
  limit: LIMIT,
  targetCurrency: "EUR",
}).catch((error) => {
  console.error("FATAL:", error && error.stack ? error.stack : String(error));
  process.exit(1);
});
