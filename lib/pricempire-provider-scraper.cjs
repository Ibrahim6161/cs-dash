const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_HEADERS = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,nl;q=0.8",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "upgrade-insecure-requests": "1",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
};

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

function slugifyCaseName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[:']/g, "")
    .replace(/&/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

function titleFromSlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function sanitizeTag(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeProviderKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeProviderLabel(value, fallback = "Unknown provider") {
  const label = cleanText(value);
  if (label) return label;
  const key = normalizeProviderKey(fallback);
  if (!key) return "Unknown provider";
  return key
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function loadItemsFromCasesFile(filePath, limit) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const cases = Array.isArray(raw?.cases) ? raw.cases : [];
    const seen = new Set();
    const items = [];

    for (const entry of cases) {
      const name = cleanText(entry?.case || entry?.name);
      if (!name) continue;
      const slug = slugifyCaseName(name);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      items.push({ slug, name });
    }

    return items.slice(0, limit);
  } catch {
    return [];
  }
}

function extractNuxtData(html) {
  const marker = 'id="__NUXT_DATA__"';
  const start = String(html || "").indexOf(marker);
  if (start === -1) {
    throw new Error("NUXT_DATA_MISSING");
  }

  const open = html.indexOf(">", start);
  const close = html.indexOf("</script>", open);
  if (open === -1 || close === -1) {
    throw new Error("NUXT_DATA_BROKEN");
  }

  return JSON.parse(html.slice(open + 1, close));
}

function createResolver(data) {
  const cache = new Map();

  function resolve(node) {
    if (typeof node === "number") {
      if (!Number.isInteger(node) || node < 0 || node >= data.length) return node;
      if (cache.has(node)) return cache.get(node);
      const resolved = resolveValue(data[node]);
      cache.set(node, resolved);
      return resolved;
    }
    return resolveValue(node);
  }

  function resolveValue(value) {
    if (Array.isArray(value)) {
      const tag = value[0];
      if (tag === "Reactive" || tag === "ShallowReactive" || tag === "Ref" || tag === "EmptyRef") {
        return resolve(value[1]);
      }
      if (tag === "Set") {
        return value.slice(1).map((entry) => resolve(entry));
      }
      return value.map((entry) => resolve(entry));
    }

    if (value && typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = resolve(entry);
      }
      return out;
    }

    return value;
  }

  return resolve;
}

function looksLikeAssetItem(raw) {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "slug") && Object.prototype.hasOwnProperty.call(raw, "prices");
}

function looksLikeSiteState(raw) {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "currencies") && Object.prototype.hasOwnProperty.call(raw, "currency");
}

function findAssetItem(data, resolve, slug) {
  for (let index = 0; index < data.length; index += 1) {
    const raw = data[index];
    if (!looksLikeAssetItem(raw)) continue;
    const item = resolve(index);
    if (item?.slug === slug && Array.isArray(item.prices)) {
      return item;
    }
  }
  return null;
}

function findCurrencyContext(data, resolve) {
  for (let index = 0; index < data.length; index += 1) {
    const raw = data[index];
    if (!looksLikeSiteState(raw)) continue;

    const current = resolve(raw.currency);
    const currencies = resolve(raw.currencies);
    if (!current || !Array.isArray(currencies) || !currencies.length) continue;

    const rates = new Map();
    for (const currency of currencies) {
      const code = String(currency?.code || "").toUpperCase();
      const rate = Number(currency?.rate);
      if (!code || !Number.isFinite(rate) || rate <= 0) continue;
      rates.set(code, { ...currency, code, rate });
    }

    if (rates.size) {
      return {
        current: {
          code: String(current.code || "USD").toUpperCase(),
          rate: Number(current.rate) || 1,
          symbol: current.symbol || "$",
        },
        rates,
      };
    }
  }

  return {
    current: { code: "USD", rate: 1, symbol: "$" },
    rates: new Map([["USD", { code: "USD", rate: 1, symbol: "$" }]]),
  };
}

function findProviderCatalog(data, resolve) {
  const catalog = new Map();

  for (let index = 0; index < data.length; index += 1) {
    const raw = data[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (!Object.prototype.hasOwnProperty.call(raw, "key") || !Object.prototype.hasOwnProperty.call(raw, "name")) continue;

    const provider = resolve(index);
    const providerKey = normalizeProviderKey(provider?.key);
    if (!providerKey || catalog.has(providerKey)) continue;

    catalog.set(providerKey, {
      key: providerKey,
      name: normalizeProviderLabel(provider?.name, providerKey),
      logo: provider?.logo || null,
      country: provider?.country || null,
      type: provider?.type || null,
    });
  }

  return catalog;
}

function pickProviderPrice(prices, providerKeys) {
  const wanted = providerKeys.map((entry) => normalizeProviderKey(entry)).filter(Boolean);
  if (!wanted.length || !Array.isArray(prices)) return null;

  for (const providerKey of wanted) {
    const matches = prices
      .filter((entry) => normalizeProviderKey(entry?.provider_key) === providerKey)
      .filter((entry) => entry?.status !== false)
      .filter((entry) => Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0)
      .sort((left, right) => Number(left.price) - Number(right.price));

    if (matches.length) {
      return {
        matchedProviderKey: providerKey,
        row: matches[0],
      };
    }
  }

  return null;
}

function pickAllProviderPrices(prices, providerCatalog, currencyContext, targetCurrency) {
  if (!Array.isArray(prices)) return [];

  const bestByKey = new Map();

  for (const entry of prices) {
    const providerKey = normalizeProviderKey(entry?.provider_key || entry?.providerKey);
    const numeric = Number(entry?.price);
    if (!providerKey || providerKey.endsWith("_buy") || entry?.status === false || !Number.isFinite(numeric) || numeric <= 0) continue;

    const value = convertPrice(numeric, currencyContext, targetCurrency);
    if (!Number.isFinite(value) || value <= 0) continue;

    const providerInfo = providerCatalog?.get(providerKey) || null;
    const next = {
      providerKey,
      providerName: normalizeProviderLabel(providerInfo?.name || entry?.provider_name || entry?.provider?.name, providerKey),
      value,
      count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : null,
      updatedAt: entry?.updated_at || null,
      lastCheckedAt: entry?.last_checked_at || null,
      sourceCurrency: currencyContext?.current?.code || "USD",
    };

    const current = bestByKey.get(providerKey);
    if (!current || next.value < current.value) {
      bestByKey.set(providerKey, next);
    }
  }

  return [...bestByKey.values()].sort((left, right) => {
    if (left.value !== right.value) return left.value - right.value;
    return left.providerName.localeCompare(right.providerName);
  });
}

function convertPrice(priceMinor, currencyContext, targetCurrency) {
  const numeric = Number(priceMinor);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const current = currencyContext?.current || { code: "USD", rate: 1 };
  const currentRate = Number(current.rate) || 1;
  const targetCode = String(targetCurrency || current.code || "USD").toUpperCase();
  const target = currencyContext?.rates?.get(targetCode);
  const targetRate = Number(target?.rate) || (targetCode === String(current.code || "").toUpperCase() ? currentRate : targetCode === "USD" ? 1 : null);

  if (!Number.isFinite(targetRate) || targetRate <= 0 || !Number.isFinite(currentRate) || currentRate <= 0) {
    return roundMoney(numeric / 100);
  }

  return roundMoney(((numeric / 100) / currentRate) * targetRate);
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchHtmlViaCurl(url, options = {}) {
  const timeoutSeconds = Math.max(5, Math.ceil((Math.max(1000, Number.parseInt(options.timeoutMs, 10) || DEFAULT_TIMEOUT_MS)) / 1000));
  const targetCurrency = String(options.targetCurrency || "EUR").toUpperCase();
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--compressed",
    "--fail-with-body",
    "--max-time",
    String(timeoutSeconds),
    "--cookie",
    `currency=${targetCurrency}`,
    "--header",
    `accept: ${DEFAULT_HEADERS.accept}`,
    "--header",
    `accept-language: ${DEFAULT_HEADERS["accept-language"]}`,
    "--header",
    `cache-control: ${DEFAULT_HEADERS["cache-control"]}`,
    "--header",
    `pragma: ${DEFAULT_HEADERS.pragma}`,
    "--user-agent",
    DEFAULT_HEADERS["user-agent"],
  ];

  if (options.referer) {
    args.push("--referer", options.referer);
  }

  args.push(url);

  const result = spawnSync("curl.exe", args, {
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = cleanText(result.stderr || result.stdout || "");
    throw new Error(detail ? `CURL_FAILED:${detail.slice(0, 220)}` : `CURL_EXIT_${result.status}`);
  }

  const html = String(result.stdout || "");
  if (!html) {
    throw new Error("EMPTY_RESPONSE");
  }

  if (/attention required|just a moment|verify you are human|checking your browser/i.test(html)) {
    throw new Error("CLOUDFLARE_CHALLENGE");
  }

  return html;
}

async function fetchHtml(url, options = {}) {
  const retries = Math.max(1, Number.parseInt(options.retries, 10) || 1);
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return fetchHtmlViaCurl(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(350 * attempt);
      }
    }
  }

  throw lastError || new Error("FETCH_FAILED");
}

function extractTrendingItems(html, limit) {
  const seen = new Set();
  const items = [];
  const pattern = /href="\/cs2-items\/container\/([^"#?]+)"/gi;

  for (const match of String(html || "").matchAll(pattern)) {
    const slug = decodeURIComponent(match[1]);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    items.push({
      slug,
      name: titleFromSlug(slug),
    });
    if (items.length >= limit) break;
  }

  return items;
}

async function fetchItemsFromTrending(pageNumber, limit, targetCurrency) {
  const trendingUrl = `https://pricempire.com/app/trending/cases?page=${pageNumber}&sort=current&order=DESC`;
  const html = await fetchHtml(trendingUrl, {
    retries: 2,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    targetCurrency,
  });
  return {
    url: trendingUrl,
    items: extractTrendingItems(html, limit),
  };
}

function writeDebugHtml(prefix, tag, html) {
  const suffix = tag ? `_${tag}` : "";
  const filePath = path.join(process.cwd(), `${prefix}${suffix}.html`);
  fs.writeFileSync(filePath, String(html || ""), "utf8");
  console.log(`Debug written: ${filePath}`);
}

function outputPayload(outFile, payload) {
  ensureDir(outFile);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
}

async function fetchProviderPriceForItem(item, options) {
  const url = `https://pricempire.com/cs2-items/container/${encodeURIComponent(item.slug)}`;
  const html = await fetchHtml(url, {
    retries: 3,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    targetCurrency: options.targetCurrency,
    referer: options.trendingUrl,
  });

  const data = extractNuxtData(html);
  const resolve = createResolver(data);
  const assetItem = findAssetItem(data, resolve, item.slug);

  if (!assetItem) {
    writeDebugHtml(options.debugPrefix(item.slug), "missing_item", html);
    throw new Error("ITEM_DATA_MISSING");
  }

  const match = pickProviderPrice(assetItem.prices, options.providerKeys);
  if (!match) {
    writeDebugHtml(options.debugPrefix(item.slug), "missing_provider", html);
    throw new Error(`PROVIDER_PRICE_MISSING:${options.providerKeys.join("|")}`);
  }

  const currencyContext = findCurrencyContext(data, resolve);
  const convertedPrice = convertPrice(match.row.price, currencyContext, options.targetCurrency);

  if (!Number.isFinite(convertedPrice) || convertedPrice <= 0) {
    writeDebugHtml(options.debugPrefix(item.slug), "bad_price", html);
    throw new Error("PRICE_CONVERSION_FAILED");
  }

  return {
    url,
    matchedProviderKey: match.matchedProviderKey,
    sourceCurrency: currencyContext.current.code,
    value: convertedPrice,
  };
}

async function fetchMarketplacePricesForItem(item, options) {
  const url = `https://pricempire.com/cs2-items/container/${encodeURIComponent(item.slug)}`;
  const html = await fetchHtml(url, {
    retries: 3,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    targetCurrency: options.targetCurrency,
    referer: options.trendingUrl,
  });

  const data = extractNuxtData(html);
  const resolve = createResolver(data);
  const assetItem = findAssetItem(data, resolve, item.slug);

  if (!assetItem) {
    writeDebugHtml(options.debugPrefix(item.slug), "missing_item", html);
    throw new Error("ITEM_DATA_MISSING");
  }

  const currencyContext = findCurrencyContext(data, resolve);
  const providerCatalog = findProviderCatalog(data, resolve);
  const prices = pickAllProviderPrices(assetItem.prices, providerCatalog, currencyContext, options.targetCurrency);

  if (!prices.length) {
    writeDebugHtml(options.debugPrefix(item.slug), "missing_marketplaces", html);
    throw new Error("MARKETPLACE_PRICES_MISSING");
  }

  return {
    url,
    prices,
    providers: providerCatalog,
  };
}

async function runProviderScrape(options) {
  const outFile = options?.outFile;
  const casesFile = options?.casesFile || "cases.json";
  const pageNumber = Number.parseInt(options?.page, 10) || 1;
  const limit = Number.parseInt(options?.limit, 10) || 50;
  const providerLabel = options?.providerLabel || "Provider";
  const targetCurrency = String(options?.targetCurrency || "EUR").toUpperCase();
  const providerKeys = Array.isArray(options?.providerKeys)
    ? options.providerKeys.map((entry) => normalizeProviderKey(entry)).filter(Boolean)
    : [];
  const providerTag = sanitizeTag(providerLabel);

  if (!outFile) throw new Error("OUT_FILE_REQUIRED");
  if (!providerKeys.length) throw new Error("PROVIDER_KEYS_REQUIRED");

  const trendingUrl = `https://pricempire.com/app/trending/cases?page=${pageNumber}&sort=current&order=DESC`;
  const map = {};
  const errors = [];

  let items = loadItemsFromCasesFile(casesFile, limit);
  let source = `cases file (${path.basename(casesFile)})`;

  if (!items.length) {
    const fallback = await fetchItemsFromTrending(pageNumber, limit, targetCurrency);
    items = fallback.items;
    source = "trending fallback";
  }

  if (!items.length) {
    throw new Error("NO_CASE_SLUGS_AVAILABLE");
  }

  console.log(`Using ${items.length} items from ${source}`);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const prefix = `debug_pricempire_${providerTag}_${item.slug}`;

    console.log(`[${index + 1}/${items.length}] ${item.name} (${item.slug})`);

    try {
      const result = await fetchProviderPriceForItem(item, {
        providerKeys,
        targetCurrency,
        trendingUrl,
        debugPrefix: () => prefix,
      });
      map[item.name] = result.value;
      console.log(`${providerLabel} = ${targetCurrency} ${result.value.toFixed(2)} via ${result.matchedProviderKey} (${result.sourceCurrency} source)`);
    } catch (error) {
      const message = String(error?.message || error);
      errors.push({
        slug: item.slug,
        name: item.name,
        url: `https://pricempire.com/cs2-items/container/${encodeURIComponent(item.slug)}`,
        reason: message,
      });
      console.log(`Failed reading ${providerLabel} price for ${item.name}: ${message}`);
    }

    await sleep(120);
  }

  const payload = {
    meta: {
      timestamp: new Date().toISOString(),
      trending_url: trendingUrl,
      page: pageNumber,
      limit,
      source,
      provider: providerLabel,
      provider_keys: providerKeys,
      currency: targetCurrency,
      scraped: Object.keys(map).length,
      errors: errors.length,
    },
    map,
    errors,
  };

  outputPayload(outFile, payload);

  if (!Object.keys(map).length) {
    throw new Error("NO_PRICES_SCRAPED");
  }

  console.log(`Done. Parsed ${Object.keys(map).length} items.`);
  console.log(`Output -> ${outFile}`);
}

async function runMarketplaceScrape(options) {
  const outFile = options?.outFile;
  const casesFile = options?.casesFile || "cases.json";
  const pageNumber = Number.parseInt(options?.page, 10) || 1;
  const limit = Number.parseInt(options?.limit, 10) || 50;
  const targetCurrency = String(options?.targetCurrency || "EUR").toUpperCase();

  if (!outFile) throw new Error("OUT_FILE_REQUIRED");

  const trendingUrl = `https://pricempire.com/app/trending/cases?page=${pageNumber}&sort=current&order=DESC`;
  const map = {};
  const providers = {};
  const errors = [];

  let items = loadItemsFromCasesFile(casesFile, limit);
  let source = `cases file (${path.basename(casesFile)})`;

  if (!items.length) {
    const fallback = await fetchItemsFromTrending(pageNumber, limit, targetCurrency);
    items = fallback.items;
    source = "trending fallback";
  }

  if (!items.length) {
    throw new Error("NO_CASE_SLUGS_AVAILABLE");
  }

  console.log(`Using ${items.length} items from ${source}`);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const prefix = `debug_pricempire_marketplaces_${item.slug}`;

    console.log(`[${index + 1}/${items.length}] ${item.name} (${item.slug})`);

    try {
      const result = await fetchMarketplacePricesForItem(item, {
        targetCurrency,
        trendingUrl,
        debugPrefix: () => prefix,
      });

      map[item.name] = result.prices;
      for (const price of result.prices) {
        const providerInfo = result.providers.get(price.providerKey);
        providers[price.providerKey] = {
          key: price.providerKey,
          name: price.providerName,
          logo: providerInfo?.logo || null,
          country: providerInfo?.country || null,
          type: providerInfo?.type || null,
        };
      }

      console.log(`${item.name}: ${result.prices.length} marketplaces`);
    } catch (error) {
      const message = String(error?.message || error);
      errors.push({
        slug: item.slug,
        name: item.name,
        url: `https://pricempire.com/cs2-items/container/${encodeURIComponent(item.slug)}`,
        reason: message,
      });
      console.log(`Failed reading marketplace prices for ${item.name}: ${message}`);
    }

    await sleep(120);
  }

  const payload = {
    meta: {
      timestamp: new Date().toISOString(),
      trending_url: trendingUrl,
      page: pageNumber,
      limit,
      source,
      currency: targetCurrency,
      scraped: Object.keys(map).length,
      providers: Object.keys(providers).length,
      errors: errors.length,
    },
    providers,
    map,
    errors,
  };

  outputPayload(outFile, payload);

  if (!Object.keys(map).length) {
    throw new Error("NO_PRICES_SCRAPED");
  }

  console.log(`Done. Parsed ${Object.keys(map).length} items across ${Object.keys(providers).length} marketplaces.`);
  console.log(`Output -> ${outFile}`);
}

module.exports = {
  createResolver,
  extractNuxtData,
  findAssetItem,
  findCurrencyContext,
  getArg,
  runMarketplaceScrape,
  runProviderScrape,
};
