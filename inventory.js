const state = {
  portfolio: null,
  loading: false,
  error: null,
  query: "",
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
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
  }).format(value);
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
    ? "rgba(255, 117, 102, 0.36)"
    : "rgba(88, 184, 255, 0.36)";
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

function inferItemType(item) {
  const text = `${item.type || ""} ${item.name || ""}`.toLowerCase();

  if (text.includes("sticker")) return "Sticker";
  if (text.includes("agent")) return "Agent";
  if (text.includes("music kit")) return "Music Kit";
  if (text.includes("graffiti")) return "Graffiti";
  if (text.includes("case")) return "Case";
  if (text.includes("medal")) return "Medal";
  if (text.includes("collectible")) return "Collectible";
  if (
    text.includes("rifle") ||
    text.includes("sniper") ||
    text.includes("pistol") ||
    text.includes("smg") ||
    text.includes("shotgun") ||
    text.includes("machinegun") ||
    text.includes("knife") ||
    text.includes("gloves")
  ) return "Weapon";

  return item.type || "Other";
}

function getFilteredItems() {
  const items = state.portfolio?.items || [];
  const search = $("searchInput").value.trim().toLowerCase();
  const typeFilter = $("typeFilter").value;
  const marketableFilter = $("marketableFilter").value;
  const tradableFilter = $("tradableFilter").value;
  const sort = $("sortSelect").value;

  let filtered = items.map((item) => ({
    ...item,
    uiType: inferItemType(item),
  }));

  if (search) {
    filtered = filtered.filter((item) =>
      String(item.name || "").toLowerCase().includes(search)
    );
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

function renderTypeFilter() {
  const select = $("typeFilter");
  const current = select.value || "ALL";
  const items = state.portfolio?.items || [];

  const types = [...new Set(items.map((item) => inferItemType(item)).filter(Boolean))].sort();

  select.innerHTML = [
    `<option value="ALL">All</option>`,
    ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`),
  ].join("");

  if (types.includes(current)) {
    select.value = current;
  } else {
    select.value = "ALL";
  }
}

function renderProfile() {
  const card = $("profileCard");

  if (state.loading) {
    card.innerHTML = `
      <strong>Loading inventory…</strong>
      <span class="muted">Reading public Steam inventory.</span>
    `;
    return;
  }

  if (state.error) {
    card.innerHTML = `
      <strong>Could not load profile</strong>
      <span class="muted">${escapeHtml(state.error)}</span>
    `;
    return;
  }

  if (!state.portfolio) {
    card.innerHTML = `
      <strong>No profile loaded</strong>
      <span class="muted">Paste a public Steam profile URL, vanity URL, or SteamID64.</span>
    `;
    return;
  }

  const profile = state.portfolio.profile || {};

  card.innerHTML = `
    <div class="inventory-profile">
      ${profile.avatar ? `<img src="${escapeHtml(profile.avatar)}" alt="" />` : ""}
      <div>
        <strong>${escapeHtml(profile.personaName || profile.steamId || "Steam profile")}</strong>
        <div class="muted">${escapeHtml(profile.steamId || "—")}</div>
      </div>
    </div>
    <span class="muted">${state.portfolio.cached ? "cached" : "fresh"} · ${fmtRelative(state.portfolio.fetchedAt)}</span>
    ${profile.profileUrl ? `<span class="muted"><a href="${escapeHtml(profile.profileUrl)}" target="_blank" rel="noopener">Open Steam profile</a></span>` : ""}
  `;
}

function renderStats() {
  const totals = state.portfolio?.totals || {};

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
      <span class="muted">Please wait while the public inventory is fetched.</span>
    `;
    return;
  }

  if (state.error) {
    info.innerHTML = `
      <strong>Inventory failed</strong>
      <span class="muted">${escapeHtml(state.error)}</span>
    `;
    return;
  }

  if (!state.portfolio) {
    info.innerHTML = `
      <strong>Nothing loaded yet</strong>
      <span class="muted">Load a public Steam inventory to browse it here.</span>
    `;
    return;
  }

  const profile = state.portfolio.profile || {};
  info.innerHTML = `
    <strong>${escapeHtml(profile.personaName || profile.steamId || "Steam profile")}</strong>
    <span class="muted">${fmtNumber(filteredItems.length)} visible items after filters · ${fmtRelative(state.portfolio.fetchedAt)}</span>
  `;
}

function renderGrid() {
  const grid = $("inventoryGrid");

  if (state.loading) {
    grid.innerHTML = `<div class="inventory-empty">Loading inventory…</div>`;
    return;
  }

  if (state.error) {
    grid.innerHTML = `<div class="inventory-empty">${escapeHtml(state.error)}</div>`;
    return;
  }

  if (!state.portfolio) {
    grid.innerHTML = `<div class="inventory-empty">No inventory loaded yet.</div>`;
    return;
  }

  const items = getFilteredItems();
  renderInfo(items);

  if (!items.length) {
    grid.innerHTML = `<div class="inventory-empty">No items match the current filters.</div>`;
    return;
  }

  grid.innerHTML = items.map((item) => `
    <article class="inventory-card">
      <div class="inventory-card-top">
        ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="" loading="lazy" />` : ""}
        <div>
          <h3 class="inventory-card-title">${escapeHtml(item.name)}</h3>
          <div class="inventory-tags">
            <span class="category-pill">${escapeHtml(item.uiType)}</span>
            <span class="metric-pill ${item.matched ? "good" : "warn"}">${item.matched ? "Matched" : "Live only"}</span>
            <span class="metric-pill">x${fmtNumber(item.quantity)}</span>
            ${item.marketable ? `<span class="metric-pill good">Marketable</span>` : `<span class="metric-pill warn">Non-marketable</span>`}
            ${item.tradable ? `<span class="metric-pill good">Tradable</span>` : `<span class="metric-pill warn">Trade locked</span>`}
          </div>
        </div>
      </div>

      <div class="muted">${escapeHtml(item.type || "Steam item")}</div>

      <div class="inventory-card-values">
        <strong>${fmtMoney(item.totalPriceEur)}</strong>
        <span class="muted">${fmtMoney(item.unitPriceEur)} each</span>
        ${item.listingUrl ? `<a class="muted" href="${escapeHtml(item.listingUrl)}" target="_blank" rel="noopener">Open market listing</a>` : ""}
      </div>
    </article>
  `).join("");
}

function render() {
  renderProfile();
  renderStats();
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
  state.query = query;
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

function wire() {
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

function bootFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const profile = params.get("profile");
  if (profile) {
    $("profileInput").value = profile;
    loadInventory(false);
  }
}

wire();
render();
bootFromUrl();