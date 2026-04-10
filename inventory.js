const state = {
  portfolio: null,
  loading: false,
  error: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNumber(value, digits = 0) {
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString(undefined, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
}

function fmtMoney(value, currency = "EUR", digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function fmtRelative(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 48) return formatter.format(diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.borderColor = isError
    ? "rgba(255, 111, 111, 0.28)"
    : "rgba(90, 183, 255, 0.28)";
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function inferType(item) {
  const text = `${item.type || ""} ${item.name || ""}`.toLowerCase();

  if (text.includes("sticker")) return "Sticker";
  if (text.includes("agent")) return "Agent";
  if (text.includes("music kit")) return "Music Kit";
  if (text.includes("graffiti")) return "Graffiti";
  if (text.includes("case")) return "Case";
  if (text.includes("medal")) return "Medal";
  if (text.includes("collectible")) return "Collectible";
  if (text.includes("knife")) return "Knife";
  if (text.includes("gloves")) return "Gloves";
  if (text.includes("rifle")) return "Rifle";
  if (text.includes("sniper")) return "Sniper";
  if (text.includes("pistol")) return "Pistol";
  if (text.includes("smg")) return "SMG";

  return item.type || "Other";
}

function renderTypeFilter() {
  const select = $("typeFilter");
  const items = state.portfolio?.items || [];
  const current = select.value || "ALL";

  const types = [...new Set(items.map((item) => inferType(item)).filter(Boolean))].sort();

  select.innerHTML = [
    `<option value="ALL">All</option>`,
    ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`),
  ].join("");

  select.value = types.includes(current) ? current : "ALL";
}

function getFilteredItems() {
  const items = (state.portfolio?.items || []).map((item) => ({
    ...item,
    uiType: inferType(item),
  }));

  const search = $("searchInput").value.trim().toLowerCase();
  const typeFilter = $("typeFilter").value;
  const marketableFilter = $("marketableFilter").value;
  const tradableFilter = $("tradableFilter").value;
  const sort = $("sortSelect").value;

  let filtered = [...items];

  if (search) {
    filtered = filtered.filter((item) => String(item.name || "").toLowerCase().includes(search));
  }

  if (typeFilter !== "ALL") {
    filtered = filtered.filter((item) => item.uiType === typeFilter);
  }

  if (marketableFilter === "MARKETABLE") {
    filtered = filtered.filter((item) => item.marketable);
  } else if (marketableFilter === "NON_MARKETABLE") {
    filtered = filtered.filter((item) => !item.marketable);
  }

  if (tradableFilter === "TRADABLE") {
    filtered = filtered.filter((item) => item.tradable);
  } else if (tradableFilter === "LOCKED") {
    filtered = filtered.filter((item) => !item.tradable);
  }

  const sorters = {
    value_desc: (a, b) => (b.totalPriceEur ?? -1) - (a.totalPriceEur ?? -1),
    value_asc: (a, b) => (a.totalPriceEur ?? 1e15) - (b.totalPriceEur ?? 1e15),
    qty_desc: (a, b) => (b.quantity ?? 0) - (a.quantity ?? 0),
    name_asc: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
    name_desc: (a, b) => String(b.name || "").localeCompare(String(a.name || "")),
  };

  filtered.sort(sorters[sort] || sorters.value_desc);
  return filtered;
}

function renderProfileCard() {
  const card = $("profileCard");

  if (state.loading) {
    card.innerHTML = `
      <strong>Loading inventory…</strong>
      <span>Reading public Steam inventory.</span>
    `;
    return;
  }

  if (state.error) {
    card.innerHTML = `
      <strong>Could not load profile</strong>
      <span>${escapeHtml(state.error)}</span>
    `;
    return;
  }

  if (!state.portfolio) {
    card.innerHTML = `
      <strong>No profile loaded</strong>
      <span>Paste a public Steam profile URL, vanity URL, or SteamID64.</span>
    `;
    return;
  }

  const profile = state.portfolio.profile || {};

  card.innerHTML = `
    <strong>${escapeHtml(profile.personaName || profile.steamId || "Steam profile")}</strong>
    <span>${escapeHtml(profile.steamId || "—")}</span>
    <span>${state.portfolio.cached ? "cached" : "fresh"} · ${fmtRelative(state.portfolio.fetchedAt)}</span>
    ${profile.profileUrl ? `<a href="${escapeHtml(profile.profileUrl)}" target="_blank" rel="noopener">Open Steam profile</a>` : ""}
  `;
}

function renderHeroStats() {
  const totals = state.portfolio?.totals || {};

  $("inventoryHeroValue").textContent = fmtMoney(totals.estimatedValueEur);
  $("inventoryHeroValueMeta").textContent = state.portfolio ? `${fmtRelative(state.portfolio.fetchedAt)}` : "Load a public profile";

  $("inventoryHeroUnique").textContent = fmtNumber(totals.uniqueItems);
  $("inventoryHeroUniqueMeta").textContent = "Distinct grouped items";

  $("inventoryHeroQuantity").textContent = fmtNumber(totals.totalQuantity);
  $("inventoryHeroQuantityMeta").textContent = "Grouped item quantity";

  $("statValue").textContent = fmtMoney(totals.estimatedValueEur);
  $("statUnique").textContent = fmtNumber(totals.uniqueItems);
  $("statQuantity").textContent = fmtNumber(totals.totalQuantity);
  $("statMarketable").textContent = fmtNumber(totals.marketableItems);
}

function renderInfo(filteredItems) {
  const info = $("inventoryInfo");

  if (state.loading) {
    info.innerHTML = `
      <strong>Loading inventory</strong>
      <span>Please wait while the public inventory is fetched.</span>
    `;
    return;
  }

  if (state.error) {
    info.innerHTML = `
      <strong>Inventory failed</strong>
      <span>${escapeHtml(state.error)}</span>
    `;
    return;
  }

  if (!state.portfolio) {
    info.innerHTML = `
      <strong>Nothing loaded yet</strong>
      <span>Load a public Steam inventory to browse it here.</span>
    `;
    return;
  }

  const profile = state.portfolio.profile || {};
  info.innerHTML = `
    <strong>${escapeHtml(profile.personaName || profile.steamId || "Steam profile")}</strong>
    <span>${fmtNumber(filteredItems.length)} visible items after filters · ${fmtRelative(state.portfolio.fetchedAt)}</span>
  `;
}

function renderGrid() {
  const grid = $("inventoryGrid");

  if (state.loading) {
    grid.innerHTML = `<div class="empty-state">Loading inventory…</div>`;
    return;
  }

  if (state.error) {
    grid.innerHTML = `<div class="empty-state">${escapeHtml(state.error)}</div>`;
    return;
  }

  if (!state.portfolio) {
    grid.innerHTML = `<div class="empty-state">No inventory loaded yet.</div>`;
    return;
  }

  const items = getFilteredItems();
  renderInfo(items);

  if (!items.length) {
    grid.innerHTML = `<div class="empty-state">No items match the current filters.</div>`;
    return;
  }

  grid.innerHTML = items.map((item) => `
    <article class="skin-card">
      <div class="skin-card-top">
        <div class="skin-card-media">
          ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="" loading="lazy" />` : ""}
        </div>

        <div>
          <h3 class="skin-card-title">${escapeHtml(item.name)}</h3>
          <div class="skin-card-tags">
            <span class="category-pill">${escapeHtml(item.uiType)}</span>
            <span class="metric-pill">x${fmtNumber(item.quantity)}</span>
            ${item.marketable ? `<span class="metric-pill good">Marketable</span>` : `<span class="metric-pill warn">Non-marketable</span>`}
            ${item.tradable ? `<span class="metric-pill good">Tradable</span>` : `<span class="metric-pill warn">Trade locked</span>`}
          </div>
        </div>
      </div>

      <div class="skin-card-copy">${escapeHtml(item.type || "Steam item")}</div>

      <div class="skin-card-values">
        <strong>${fmtMoney(item.totalPriceEur)}</strong>
        <span>${fmtMoney(item.unitPriceEur)} each</span>
        ${item.listingUrl ? `<a href="${escapeHtml(item.listingUrl)}" target="_blank" rel="noopener">Open market listing</a>` : ""}
      </div>
    </article>
  `).join("");
}

function render() {
  renderProfileCard();
  renderHeroStats();
  renderTypeFilter();
  renderGrid();
}

async function loadInventory(forceRefresh = false) {
  const query = $("profileInput").value.trim();
  if (!query) {
    showToast("Enter a Steam profile first.", true);
    return;
  }

  state.loading = true;
  state.error = null;
  render();

  try {
    const payload = await api("/api/steam/public-inventory", {
      method: "POST",
      body: JSON.stringify({
        query,
        refresh: forceRefresh,
      }),
    });

    state.portfolio = payload;
    state.error = null;
  } catch (error) {
    state.portfolio = null;
    state.error = error.message;
    showToast(error.message, true);
  } finally {
    state.loading = false;
    render();
  }
}

function bootFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const profile = params.get("profile");
  if (profile) {
    $("profileInput").value = profile;
    loadInventory(false);
  }
}

function wire() {
  $("lookupButton").addEventListener("click", () => loadInventory(false));
  $("loadInventoryButton").addEventListener("click", () => loadInventory(false));
  $("refreshInventoryButton").addEventListener("click", () => loadInventory(true));

  $("profileInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadInventory(false);
    }
  });

  $("searchInput").addEventListener("input", render);
  $("typeFilter").addEventListener("change", render);
  $("marketableFilter").addEventListener("change", render);
  $("tradableFilter").addEventListener("change", render);
  $("sortSelect").addEventListener("change", render);
}

wire();
render();
bootFromUrl();