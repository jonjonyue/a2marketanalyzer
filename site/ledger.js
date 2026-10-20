import { shortenName, parseKinah, analyzeMarket, DEFAULT_SETTINGS, shortenMarketNames } from "./metrics.js";
import { planPanel } from "./plan.js";

// Profit calculator: a personal log of exchange purchases and sales, kept in this browser (localStorage).
const API = "https://aion2.exchange";
const SNAPSHOT_URL = "data/snapshot.json";
const STORE_KEY = "a2ledger.v1";
const DEFAULTS = { taxPct: 10, feePct: 2 };
// A catch-all item for crafting materials bought, so their cost counts against profit without logging each one.
const MATERIALS = "Materials";
const isMaterials = (name) => String(name || "").trim().toLowerCase() === MATERIALS.toLowerCase();
const PERIODS = [["all", "All time"], ["30", "30 days"], ["7", "7 days"], ["1", "Today"]];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- formatting ----------
function kinah(v, { sign = false } = {}) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
  return s + Math.round(a);
}
const full = (v) => (v == null ? "—" : (v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString("en-US"));
const signClass = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");


const LISTING_HOURS = 72; // exchange listings last 3 days

// Money for one entry. Purchases cost the full price. A listing costs its listing fee when posted.
// A sale loses tax + listing fee; a sale from a logged listing has feePct 0 because the listing already paid it.
export function amounts(e) {
  const gross = e.qty * e.price;
  if (e.side === "buy") return { gross, tax: 0, fee: 0, net: -gross };
  if (e.side === "list") {
    const fee = Math.round(gross * e.feePct / 100);
    return { gross, tax: 0, fee, net: -fee };
  }
  const tax = Math.round(gross * e.taxPct / 100);
  const fee = Math.round(gross * e.feePct / 100);
  return { gross, tax, fee, net: gross - tax - fee };
}

// ---------- storage ----------
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && Array.isArray(raw.entries)) return { entries: raw.entries.filter(valid).map((e) => ({ ...e, name: shortenName(e.name) })), settings: { ...DEFAULTS, ...raw.settings } };
  } catch { /* blocked or corrupt storage: start empty */ }
  return { entries: [], settings: { ...DEFAULTS } };
}
// Your kinah lives with the Market Analysis page (it sizes the "what to craft" plan). Every change to the log
// moves it by that change's kinah effect, so buying, listing and selling here keep it current.
const BUDGET_KEY = "a2dash.budget";
function readKinah() {
  try { const v = parseKinah(localStorage.getItem(BUDGET_KEY)); return Number.isFinite(v) ? v : null; } catch { return null; }
}
function writeKinah(v) {
  try { v == null ? localStorage.removeItem(BUDGET_KEY) : localStorage.setItem(BUDGET_KEY, String(Math.max(0, Math.round(v)))); } catch { /* not saved */ }
}
const logNet = (entries) => entries.reduce((t, e) => t + amounts(e).net, 0);

function save({ adjustKinah = true } = {}) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ entries: state.entries, settings: state.settings }));
    const net = logNet(state.entries);
    const delta = net - state.lastNet;
    state.lastNet = net;
    const have = readKinah();
    if (adjustKinah && delta && have != null) {
      writeKinah(have + delta);
      showKinah(delta);
    }
    return true;
  } catch {
    toast("Couldn't save in this browser (private window or storage blocked). Export a backup before closing.");
    return false;
  }
}
function valid(e) {
  return e && typeof e.id === "string" && (e.side === "buy" || e.side === "sell" || e.side === "list") && Number.isFinite(e.qty) && e.qty > 0
    && Number.isFinite(e.price) && e.price >= 0 && Number.isFinite(e.ts) && typeof e.name === "string";
}
const salesOf = (listing, except = null) => state.entries.filter((x) => x.side === "sell" && x.listingId === listing.id && x.id !== except);
const soldQty = (listing, except = null) => salesOf(listing, except).reduce((n, x) => n + x.qty, 0);
const remaining = (listing) => Math.max(0, listing.qty - soldQty(listing));
const isActive = (e) => e.side === "list" && !e.expired && remaining(e) > 0;
const listingOf = (sale) => (sale.listingId ? state.entries.find((x) => x.id === sale.listingId) : null);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const stored = load();
const state = {
  entries: stored.entries,
  settings: stored.settings,
  period: "all",
  side: "sell",
  editing: null,       // id of the entry being edited
  catalog: new Map(),  // lowercase name -> { key, name, price, icon }
  sort: { key: "ts", dir: -1 },
  lastNet: 0,          // the log's total kinah effect at the last save, to move "your kinah" by each change
  options: [],         // catalog items for the search dropdown, sorted by name
  menu: { items: [], active: -1 },
};

// ---------- item catalog from the dashboard's snapshot ----------
async function loadCatalog() {
  try {
    // Prices come from the server picked on the Market Analysis page (remembered in this browser).
    const snap = await (await fetch(SNAPSHOT_URL, { cache: "no-cache" })).json();
    let sid = 11201;
    try { sid = parseInt(localStorage.getItem("a2dash.server"), 10) || sid; } catch { /* default server */ }
    const servers = snap.servers || [];
    const srv = servers.find((x) => x.server_id === sid) || servers.find((x) => x.server_id === snap.default_server) || servers[0];
    if (srv) $("serverName").textContent = `${srv.name} · ${srv.faction} · ${srv.region_name || srv.region}`;
    const market = snap.markets
      ? snap.markets[String(srv?.server_id)] || Object.values(snap.markets)[0] || {}
      : (await (await fetch(`data/servers/${srv.server_id}.json`)).json()).market || {};
    const icons = market.icons || {};
    state.planMarket = shortenMarketNames(JSON.parse(JSON.stringify(market)));
    state.planServer = srv?.name;
    const add = (key, rawName, price) => {
      const name = shortenName(rawName);
      if (!name) return;
      const k = name.toLowerCase();
      const prev = state.catalog.get(k);
      if (!prev || (prev.price == null && price != null)) state.catalog.set(k, { key, name, price: price ?? null, icon: icons[key] });
    };
    const itemPrice = new Map((market.items || []).map((i) => [i.item_key, i.price]));
    for (const t of market.targets || []) add(t.target_key, t.name, itemPrice.get(t.target_key) ?? t.market_price);
    for (const m of market.materials || []) add(m.item_key, m.name, m.price);
    for (const c of Object.values(market.chains || {})) {
      for (const tr of c.tiers || []) add(tr.item_key, tr.name, tr.market_price);
      for (const s of c.steps || []) for (const m of s.materials || []) add(m.material_key, m.name, m.listing_price);
    }
    // Names already in the log stay suggestable even if the snapshot doesn't have them.
    for (const e of state.entries) if (!state.catalog.has(e.name.toLowerCase())) add(e.key ?? null, e.name, null);
    const names = [...state.catalog.values()].filter((i) => !isMaterials(i.name)).sort((a, b) => a.name.localeCompare(b.name));
    state.options = names;
    if (document.activeElement === $("item")) openMenu();
    render();
  } catch { /* the item list is a convenience; typing any name still works */ }
}

function iconHtml(icon, cls = "small") {
  if (!icon) return "";
  const [file, color, rarity] = icon;
  const style = /^#[0-9a-f]{6}$/i.test(color || "") ? ` style="--rarity:${color}"` : "";
  return `<img class="item-icon ${cls}" src="${API}/item-icons/${encodeURIComponent(file)}.webp" alt=""${style} title="${esc(rarity || "")}" loading="lazy" decoding="async" onerror="this.remove()">`;
}
// Icon markup for a logged entry or item group; Materials gets its own badge.
function entryIcon(e, cls = "small") {
  if (isMaterials(e.name)) return `<span class="mat-icon ${cls}" aria-hidden="true">⚒</span>`;
  return iconHtml(iconFor(e), cls);
}
const lookup = (name) => state.catalog.get(String(name || "").trim().toLowerCase());
const iconFor = (e) => (e.key != null && [...state.catalog.values()].find((c) => c.key === e.key)?.icon) || lookup(e.name)?.icon;

// ---------- item search dropdown ----------
const MAX_RESULTS = 60;
function matches(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const mat = { name: MATERIALS, label: "Crafting materials (any)", materials: true };
  if (!words.length) return [mat, ...state.options.slice(0, MAX_RESULTS)];
  const scored = [];
  for (const i of state.options) {
    const n = i.name.toLowerCase();
    if (!words.every((w) => n.includes(w))) continue;
    scored.push([n.startsWith(words[0]) ? 0 : n.includes(" " + words[0]) ? 1 : 2, i]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  const out = scored.slice(0, MAX_RESULTS).map(([, i]) => i);
  if (words.every((w) => "materials crafting".includes(w) || MATERIALS.toLowerCase().startsWith(w))) out.unshift(mat);
  return out;
}
function highlight(name, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return esc(name);
  const lower = name.toLowerCase();
  const marks = new Array(name.length).fill(false);
  for (const w of words) { const i = lower.indexOf(w); if (i >= 0) for (let k = i; k < i + w.length; k++) marks[k] = true; }
  let html = "", open = false;
  for (let k = 0; k < name.length; k++) {
    if (marks[k] !== open) { html += marks[k] ? "<mark>" : "</mark>"; open = marks[k]; }
    html += esc(name[k]);
  }
  return html + (open ? "</mark>" : "");
}
function openMenu() {
  const q = $("item").value.trim();
  const items = matches(q);
  state.menu = { items, active: -1 };
  const menu = $("itemMenu");
  menu.innerHTML = items.length
    ? items.map((i, idx) => `<li role="option" id="opt-${idx}" data-idx="${idx}" aria-selected="false">
        ${i.materials ? `<span class="mat-icon small" aria-hidden="true">⚒</span>` : iconHtml(i.icon, "small") || `<span class="icon-gap"></span>`}
        <span class="opt-name">${i.materials ? `<strong>${esc(i.name)}</strong> <span class="muted">· ${esc(i.label)}</span>` : highlight(i.name, q)}</span>
        <span class="opt-price">${i.price != null ? kinah(i.price) : ""}</span>
      </li>`).join("")
    : `<li class="combo-empty">No match. "${esc(q)}" will be logged as a new item.</li>`;
  menu.hidden = false;
  $("item").setAttribute("aria-expanded", "true");
}
function closeMenu() {
  $("itemMenu").hidden = true;
  $("item").setAttribute("aria-expanded", "false");
  $("item").removeAttribute("aria-activedescendant");
  state.menu.active = -1;
}
function moveActive(delta) {
  const n = state.menu.items.length;
  if (!n) return;
  const menu = $("itemMenu");
  state.menu.active = (state.menu.active + delta + n) % n;
  for (const li of menu.querySelectorAll("[role=option]")) li.setAttribute("aria-selected", String(Number(li.dataset.idx) === state.menu.active));
  const el = $(`opt-${state.menu.active}`);
  el?.scrollIntoView({ block: "nearest" });
  $("item").setAttribute("aria-activedescendant", `opt-${state.menu.active}`);
}
function pickItem(name) {
  $("item").value = name;
  closeMenu();
  if (isMaterials(name)) {
    if (state.side !== "buy" && !state.editing) setSide("buy");
  } else {
    const item = lookup(name);
    if (item && !$("price").value && item.price != null) $("price").value = item.price;
  }
  updatePreview();
  $(isMaterials(name) || !$("price").value ? "price" : "qty").focus();
}
function wireCombo() {
  const input = $("item"), menu = $("itemMenu");
  input.addEventListener("focus", openMenu);
  input.addEventListener("click", () => { if (menu.hidden) openMenu(); });
  input.addEventListener("input", openMenu);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); if (menu.hidden) openMenu(); moveActive(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); if (menu.hidden) openMenu(); moveActive(-1); }
    else if (ev.key === "Enter" && !menu.hidden && state.menu.active >= 0) { ev.preventDefault(); pickItem(state.menu.items[state.menu.active].name); }
    else if (ev.key === "Escape" && !menu.hidden) { ev.preventDefault(); closeMenu(); }
    else if (ev.key === "Tab") closeMenu();
  });
  // mousedown (not click) so the pick happens before the input loses focus
  menu.addEventListener("mousedown", (ev) => {
    const li = ev.target.closest("[role=option]");
    ev.preventDefault();
    if (li) pickItem(state.menu.items[Number(li.dataset.idx)].name);
  });
  input.addEventListener("blur", () => setTimeout(closeMenu, 0));
}

// ---------- form ----------
function setSide(side) {
  state.side = side;
  for (const b of $("side").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === side));
  $("side").dataset.side = side;
  updatePreview();
}

function localInputValue(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readForm() {
  const name = shortenName($("item").value.trim());
  const qty = Number($("qty").value);
  const price = parseKinah($("price").value);
  const ts = $("when").value ? new Date($("when").value).getTime() : Date.now();
  const editing = state.editing && state.entries.find((x) => x.id === state.editing);
  const taxPct = editing ? editing.taxPct : state.settings.taxPct;
  const feePct = editing ? editing.feePct : state.settings.feePct;
  return { name, qty, price, ts, taxPct, feePct, side: state.side, note: $("note").value.trim() };
}

function formProblem(f) {
  if (!f.name) return "Pick or type an item.";
  if (!Number.isInteger(f.qty) || f.qty < 1) return "Quantity must be a whole number, 1 or more.";
  if (!Number.isFinite(f.price) || f.price < 0) return "Price must be a number, like 1500000, 1.5m or 250k.";
  if (!Number.isFinite(f.ts)) return "Pick a date.";
  const editing = state.editing && state.entries.find((x) => x.id === state.editing);
  if (editing?.listingId) {
    const listing = listingOf(editing);
    if (f.side !== "sell") return "This sale came from a listing. Delete it instead to undo the sale.";
    if (listing && f.qty > listing.qty - soldQty(listing, editing.id)) return `Only ${listing.qty - soldQty(listing, editing.id)} left on that listing.`;
  }
  if (editing?.side === "list") {
    const sold = soldQty(editing);
    if (sold && f.side !== "list") return "This listing has sales logged against it. Delete those first to change its type.";
    if (f.qty < sold) return `${sold} of this listing are already marked sold, so the quantity can't go below that.`;
  }
  return null;
}

function updatePreview() {
  const f = readForm();
  const item = lookup(f.name);
  $("itemIcon").innerHTML = isMaterials(f.name) ? entryIcon(f) : iconHtml(item?.icon, "small");
  const priceHint = item?.price != null ? ` <span class="muted">· cheapest listing now ${full(item.price)}</span>` : "";
  if (!Number.isFinite(f.price) || !(f.qty >= 1)) {
    $("preview").innerHTML = item ? `<span class="muted">${esc(item.name)}</span>${priceHint}` : "";
    return;
  }
  const a = amounts(f);
  if (f.side === "list") {
    const tax = Math.round(a.gross * f.taxPct / 100);
    $("preview").innerHTML = `<strong class="neg">Listing fee ${full(a.fee)}</strong> (${f.feePct}% of ${full(a.gross)}) paid now · ` +
      `if it all sells you receive <strong class="pos">${full(a.gross - tax)}</strong> after ${f.taxPct}% tax${priceHint}`;
    return;
  }
  $("preview").innerHTML = f.side === "sell"
    ? `${full(a.gross)} − tax ${full(a.tax)} (${f.taxPct}%)${f.feePct ? ` − listing fee ${full(a.fee)} (${f.feePct}%)` : " (listing fee already paid)"} = <strong class="pos">you receive ${full(a.net)}</strong>${priceHint}`
    : `<strong class="neg">You pay ${full(a.gross)}</strong> <span class="muted">(${f.qty} × ${full(f.price)})</span>${isMaterials(f.name) ? ` <span class="muted">· counted as crafting materials</span>` : priceHint}`;
}

function submit(ev) {
  ev.preventDefault();
  const f = readForm();
  const problem = formProblem(f);
  $("formError").hidden = !problem;
  $("formError").textContent = problem || "";
  if (problem) return;
  const item = lookup(f.name);
  const entry = { ...f, name: isMaterials(f.name) ? MATERIALS : item?.name || f.name, key: isMaterials(f.name) ? null : item?.key ?? null };
  if (state.editing) {
    const i = state.entries.findIndex((x) => x.id === state.editing);
    if (i >= 0) state.entries[i] = { ...state.entries[i], ...entry };
    toast("Entry updated.");
  } else {
    state.entries.push({ id: newId(), ...entry });
    toast(isMaterials(entry.name) && f.side === "buy"
      ? `Materials added: ${full(amounts(entry).gross)} spent.`
      : `${{ sell: "Sale", buy: "Purchase", list: "Listing" }[f.side]} added: ${f.qty} × ${entry.name}.`);
  }
  save();
  resetForm({ keepItem: !state.editing });
  render();
}

function resetForm({ keepItem = false } = {}) {
  state.editing = null;
  $("formTitle").textContent = "Add a transaction";
  $("submitBtn").textContent = "Add";
  $("cancelEdit").hidden = true;
  if (!keepItem) $("item").value = "";
  $("qty").value = 1;
  $("price").value = "";
  $("note").value = "";
  $("when").value = localInputValue(Date.now());
  $("formError").hidden = true;
  updatePreview();
}

function startEdit(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  state.editing = id;
  setSide(e.side);
  $("item").value = e.name;
  $("qty").value = e.qty;
  $("price").value = e.price;
  $("when").value = localInputValue(e.ts);
  $("note").value = e.note || "";
  $("formTitle").textContent = "Edit transaction";
  $("submitBtn").textContent = "Save";
  $("cancelEdit").hidden = false;
  updatePreview();
  $("entryForm").scrollIntoView({ behavior: "smooth", block: "start" });
  $("price").focus({ preventScroll: true });
}

let undo = null;
function remove(id) {
  const i = state.entries.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [gone] = state.entries.splice(i, 1);
  // Deleting a listing also deletes the sales marked against it.
  const linked = gone.side === "list" ? state.entries.filter((x) => x.listingId === gone.id) : [];
  if (linked.length) state.entries = state.entries.filter((x) => x.listingId !== gone.id);
  if (state.editing === id || linked.some((x) => x.id === state.editing)) resetForm();
  save();
  render();
  undo = () => { state.entries.push(gone, ...linked); save(); render(); };
  toast(`Deleted ${gone.qty} × ${gone.name}${linked.length ? ` and its ${linked.length} sale${linked.length > 1 ? "s" : ""}` : ""}.`, "Undo");
}

// ---------- listings ----------
function markSold(id, qty) {
  const l = state.entries.find((x) => x.id === id);
  if (!l) return;
  const left = remaining(l);
  if (!Number.isInteger(qty) || qty < 1 || qty > left) return toast(`Enter how many sold, 1 to ${left}.`);
  const sale = { id: newId(), side: "sell", listingId: l.id, name: l.name, key: l.key ?? null, qty, price: l.price,
    taxPct: l.taxPct, feePct: 0, ts: Date.now(), note: "" };
  state.entries.push(sale);
  save();
  render();
  undo = () => { state.entries = state.entries.filter((x) => x.id !== sale.id); save(); render(); };
  const a = amounts(sale);
  toast(`Sold ${qty} × ${l.name}: +${full(a.net)} after tax.`, "Undo");
}

function markExpired(id, { relist = false } = {}) {
  const l = state.entries.find((x) => x.id === id);
  if (!l) return;
  const left = remaining(l);
  l.expired = true;
  l.expiredTs = Date.now();
  let fresh = null;
  if (relist && left > 0) {
    fresh = { id: newId(), side: "list", name: l.name, key: l.key ?? null, qty: left, price: l.price,
      taxPct: state.settings.taxPct, feePct: state.settings.feePct, ts: Date.now(), note: l.note || "" };
    state.entries.push(fresh);
  }
  save();
  render();
  undo = () => {
    delete l.expired; delete l.expiredTs;
    if (fresh) state.entries = state.entries.filter((x) => x.id !== fresh.id);
    save(); render();
  };
  toast(fresh ? `Relisted ${left} × ${l.name}: new listing fee ${full(amounts(fresh).fee)}.` : `Marked ${left} × ${l.name} as expired; the listing fee is lost.`, "Undo");
}

function timeLeft(l) {
  const ms = l.ts + LISTING_HOURS * 3600e3 - Date.now();
  const h = Math.abs(ms) / 3600e3;
  const txt = h >= 24 ? `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h` : h >= 1 ? `${Math.floor(h)}h` : `${Math.max(1, Math.round(h * 60))}m`;
  return ms > 0 ? { text: `in ${txt}`, over: false } : { text: `${txt} ago`, over: true };
}

function renderListings() {
  const active = state.entries.filter(isActive).sort((a, b) => a.ts - b.ts);
  const panel = $("listingsPanel");
  panel.hidden = !active.length;
  if (!active.length) return;
  let units = 0, value = 0;
  const rows = active.map((l) => {
    const left = remaining(l);
    const gross = left * l.price;
    const net = gross - Math.round(gross * l.taxPct / 100);
    units += left; value += net;
    const t = timeLeft(l);
    return `<tr${t.over ? ' class="overdue"' : ""}>
      <td class="name"><span class="item-cell">${entryIcon(l)}<span>${esc(l.name)}</span></span></td>
      <td class="dim">${esc(new Date(l.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</td>
      <td class="${t.over ? "warn" : "dim"}" title="Listings last 3 days">${t.over ? "Expired " : "Expires "}${t.text}</td>
      <td>${left.toLocaleString()}${left < l.qty ? ` <span class="dim">of ${l.qty.toLocaleString()}</span>` : ""}</td>
      <td title="${full(l.price)}">${kinah(l.price)}</td>
      <td class="pos" title="${full(net)} after ${l.taxPct}% tax">${kinah(net)}</td>
      <td class="listing-actions">
        <label class="sr-only" for="sold-${esc(l.id)}">Quantity sold</label>
        <input type="number" id="sold-${esc(l.id)}" class="sold-qty" min="1" max="${left}" step="1" value="${left}" inputmode="numeric">
        <button type="button" class="mini-btn good" data-sold="${esc(l.id)}">Mark sold</button>
        <button type="button" class="mini-btn" data-expire="${esc(l.id)}" title="It didn't sell: close the listing (the listing fee is lost)">Expired</button>
        <button type="button" class="mini-btn" data-relist="${esc(l.id)}" title="Close it as expired and post the unsold units again, paying a new listing fee">Relist</button>
      </td>
    </tr>`;
  }).join("");
  $("listingsNote").textContent = `${units.toLocaleString()} unit${units === 1 ? "" : "s"} on the market, worth ${kinah(value)} after tax if they all sell.`;
  $("listings").querySelector("thead").innerHTML = `<tr><th>Item</th><th>Listed</th><th>Status</th><th>Left</th><th>Price each</th><th>If sold</th><th><span class="sr-only">Actions</span></th></tr>`;
  $("listings").querySelector("tbody").innerHTML = rows;
}

// ---------- totals ----------
function inPeriod(e) {
  if (state.period === "all") return true;
  if (state.period === "1") {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return e.ts >= start.getTime();
  }
  return e.ts >= Date.now() - Number(state.period) * 86400e3;
}

function totals(entries) {
  const t = { received: 0, spent: 0, tax: 0, fee: 0, sold: 0, bought: 0, listingFees: 0, profit: 0 };
  for (const e of entries) {
    const a = amounts(e);
    t.profit += a.net;
    if (e.side === "sell") { t.received += a.net; t.tax += a.tax; t.fee += a.fee; t.sold += e.qty; }
    else if (e.side === "list") { t.fee += a.fee; t.listingFees += a.fee; }
    else { t.spent += a.gross; t.bought += e.qty; if (isMaterials(e.name)) t.materials = (t.materials || 0) + a.gross; }
  }
  return t;
}

function byItem(entries) {
  const groups = new Map();
  for (const e of entries) {
    const k = e.name.toLowerCase();
    if (!groups.has(k)) groups.set(k, { name: e.name, key: e.key, iconHtml: entryIcon(e, ""), list: [] });
    groups.get(k).list.push(e);
  }
  return [...groups.values()].map((g) => {
    const t = totals(g.list);
    const buys = g.list.filter((e) => e.side === "buy"), sells = g.list.filter((e) => e.side === "sell");
    const avg = (list) => (list.length ? list.reduce((s, e) => s + e.qty * e.price, 0) / list.reduce((s, e) => s + e.qty, 0) : null);
    // Units still listed are counted from every active listing, not just this period's.
    const listed = state.entries.filter((e) => isActive(e) && e.name.toLowerCase() === g.name.toLowerCase()).reduce((n, e) => n + remaining(e), 0);
    return { ...g, ...t, avgBuy: avg(buys), avgSell: avg(sells), listed, onHand: t.bought - t.sold - listed, last: Math.max(...g.list.map((e) => e.ts)) };
  }).sort((a, b) => b.profit - a.profit);
}

// ---------- render ----------
// ---------- what to craft with your kinah (same plan as Market Analysis, from plan.js) ----------
// Uses the settings last used on Market Analysis (filters, share of sales, price basis, proficiency) in this browser.
function planSettings() {
  let saved = {}, prof = {};
  try { saved = JSON.parse(localStorage.getItem("a2dash.planSettings") || "null") || {}; } catch { /* defaults */ }
  try { prof = JSON.parse(localStorage.getItem("a2dash.proficiency") || "null") || {}; } catch { /* defaults */ }
  const proficiency = { ...DEFAULT_SETTINGS.proficiency };
  for (const [k, v] of Object.entries(prof)) if (k in proficiency && Number.isInteger(v) && v >= 1 && v <= 100) proficiency[k] = v;
  const pick = (k, ok) => (ok(saved[k]) ? saved[k] : DEFAULT_SETTINGS[k]);
  const num = (lo, hi) => (v) => Number.isFinite(v) && v >= lo && v <= hi;
  return {
    settings: { ...DEFAULT_SETTINGS, proficiency,
      sharePct: pick("sharePct", num(1, 100)), salesTaxPct: pick("salesTaxPct", num(0, 50)), listingFeePct: pick("listingFeePct", num(0, 50)),
      priceBasis: pick("priceBasis", (v) => ["conservative", "listing", "sold"].includes(v)),
      costBasis: pick("costBasis", (v) => ["cheapest", "market"].includes(v)) },
    tier: typeof saved.tier === "string" ? saved.tier : "All",
    skill: typeof saved.skill === "string" ? saved.skill : "All",
  };
}

function renderPlan() {
  const body = $("planBody");
  if (!body) return;
  if (!state.planMarket) { body.innerHTML = `<p class="muted plan-empty">Loading market data…</p>`; return; }
  const { settings, tier, skill } = planSettings();
  let rows = analyzeMarket(state.planMarket, settings);
  if (tier !== "All") rows = rows.filter((r) => r.tier === tier);
  if (skill !== "All") rows = rows.filter((r) => r.skill === skill);
  const budget = readKinah();
  const filters = [tier !== "All" && tier, skill !== "All" && skill].filter(Boolean).join(", ");
  const { note, html } = planPanel({
    rows, budget: budget > 0 ? budget : null, settings, serverName: state.planServer,
    iconHtml: (key, cls) => iconHtml(state.planMarket.icons?.[key], cls),
    scope: `with your Market Analysis settings${filters ? ` (${filters})` : ""}`,
    emptyHint: "Enter your kinah below (next to the tax and fee settings) to see what to craft with it.",
  });
  $("planNote").textContent = note;
  body.innerHTML = html;
}

function render() {
  const entries = state.entries.filter(inPeriod);
  renderPlan();
  renderListings();
  renderKpis(entries);
  renderByItem(entries);
  renderTransactions(entries);
}

function renderKpis(entries) {
  const t = totals(entries);
  const label = PERIODS.find(([v]) => v === state.period)[1].toLowerCase();
  const kpi = (lab, value, sub, cls = "") => `<div class="kpi"><div class="label">${lab}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
  $("kpis").innerHTML = [
    kpi(t.profit >= 0 ? "Kinah made" : "Kinah lost", kinah(t.profit, { sign: true }), `${full(t.profit)} · ${label}`, signClass(t.profit)),
    kpi("Received from sales", kinah(t.received), `${t.sold.toLocaleString()} sold, after tax and fees`),
    kpi("Spent buying", kinah(t.spent), t.materials ? `${kinah(t.materials)} on crafting materials` : `${t.bought.toLocaleString()} bought`),
    kpi("Tax and fees paid", kinah(t.tax + t.fee), `${kinah(t.tax)} tax · ${kinah(t.fee)} listing fees`),
  ].join("");
}

function renderByItem(entries) {
  const rows = byItem(entries);
  $("byItem").querySelector("thead").innerHTML = `<tr><th>Item</th><th>Bought</th><th>Avg buy</th><th>Spent</th><th>Sold</th><th>Avg sell</th><th>Received</th><th>Profit</th><th>Listed</th><th>On hand</th></tr>`;
  $("byItem").querySelector("tbody").innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td class="name"><span class="item-cell">${r.iconHtml}<span class="item-text"><strong>${esc(isMaterials(r.name) ? "Crafting materials" : r.name)}</strong>${isMaterials(r.name) ? `<span class="meta">Bought to craft</span>` : ""}</span></span></td>
        <td>${r.bought ? r.bought.toLocaleString() : "—"}</td>
        <td>${kinah(r.avgBuy)}</td>
        <td>${r.spent ? kinah(r.spent) : "—"}</td>
        <td>${r.sold ? r.sold.toLocaleString() : "—"}</td>
        <td>${kinah(r.avgSell)}</td>
        <td>${r.received ? kinah(r.received) : "—"}</td>
        <td class="${signClass(r.profit)}" title="${full(r.profit)}">${kinah(r.profit, { sign: true })}</td>
        <td>${r.listed ? r.listed.toLocaleString() : "—"}</td>
        <td title="${r.onHand < 0 ? "More sold or listed than bought here (crafted or bought before you started logging)" : ""}">${r.onHand < 0 || !r.bought || isMaterials(r.name) ? "—" : r.onHand.toLocaleString()}</td>
      </tr>`).join("")
    : `<tr><td colspan="10" class="empty-row">${state.entries.length ? "No transactions in this period." : "Nothing logged yet. Add your first purchase or sale above."}</td></tr>`;
}

function typeCell(e) {
  if (e.side === "buy") return `<span class="pill neutral bought">Bought</span>`;
  if (e.side === "sell") return `<span class="pill good sold">Sold</span>${e.listingId ? `<span class="type-sub">from listing</span>` : ""}`;
  const sold = soldQty(e), left = e.qty - sold;
  const sub = left <= 0 ? "all sold" : e.expired ? `expired · ${left} unsold` : sold ? `${left} of ${e.qty} left` : "on the market";
  return `<span class="pill listed${isActive(e) ? "" : " closed"}">Listed</span><span class="type-sub">${sub}</span>`;
}
function deductTitle(e, a) {
  if (e.side === "buy") return "No tax on purchases";
  if (e.side === "list") return `Listing fee ${full(a.fee)} (${e.feePct}%), paid when listed`;
  return e.listingId ? `Tax ${full(a.tax)} (${e.taxPct}%); listing fee was paid on the listing` : `Tax ${full(a.tax)} (${e.taxPct}%) + listing fee ${full(a.fee)} (${e.feePct}%)`;
}

const TX_COLS = [
  ["ts", "Date"], ["name", "Item"], ["side", "Type"], ["qty", "Qty"], ["price", "Price each"],
  ["gross", "Total"], ["deduct", "Tax + fee"], ["net", "Kinah ±"], ["note", "Note"],
];

function renderTransactions(entries) {
  const { key, dir } = state.sort;
  const val = (e) => (key === "gross" || key === "net" ? amounts(e)[key] : key === "deduct" ? amounts(e).tax + amounts(e).fee : e[key]);
  const rows = [...entries].sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === "string" ? x.localeCompare(y) : (x ?? 0) - (y ?? 0)) * dir || b.ts - a.ts;
  });
  $("txTable").querySelector("thead").innerHTML = `<tr>${TX_COLS.map(([k, label]) =>
    `<th${k === key ? ` aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}><button type="button" data-sort="${k}">${label}</button></th>`).join("")}<th><span class="sr-only">Actions</span></th></tr>`;
  const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  $("txTable").querySelector("tbody").innerHTML = rows.length
    ? rows.map((e) => {
      const a = amounts(e);
      return `<tr${e.id === state.editing ? ' class="editing"' : ""}>
        <td class="dim">${esc(fmtDate(e.ts))}</td>
        <td class="name"><span class="item-cell">${entryIcon(e)}<span>${esc(e.name)}</span></span></td>
        <td>${typeCell(e)}</td>
        <td>${e.qty.toLocaleString()}</td>
        <td title="${full(e.price)}">${kinah(e.price)}</td>
        <td title="${full(a.gross)}">${kinah(a.gross)}</td>
        <td title="${deductTitle(e, a)}">${e.side === "buy" ? "—" : kinah(a.tax + a.fee)}</td>
        <td class="${signClass(a.net)}" title="${full(a.net)}">${kinah(a.net, { sign: true })}</td>
        <td class="note-cell">${esc(e.note || "")}</td>
        <td class="actions"><button type="button" class="icon-btn" data-edit="${esc(e.id)}" title="Edit" aria-label="Edit ${esc(e.name)}">✎</button><button type="button" class="icon-btn danger" data-del="${esc(e.id)}" title="Delete" aria-label="Delete ${esc(e.name)}">✕</button></td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="10" class="empty-row">${state.entries.length ? "No transactions in this period." : "No transactions yet."}</td></tr>`;
  $("txNote").textContent = entries.length ? `${entries.length} of ${state.entries.length} entries. Hover an amount for the exact figure.` : "";
}

// ---------- backup ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

function exportJson() {
  download(`aion2-ledger-${stamp()}.json`, JSON.stringify({ version: 1, exported_at: new Date().toISOString(), entries: state.entries }, null, 2), "application/json");
}
function exportCsv() {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["date", "item", "item_key", "type", "qty", "price_each", "total", "tax", "listing_fee", "kinah_change", "note"].join(",")];
  for (const e of [...state.entries].sort((a, b) => a.ts - b.ts)) {
    const a = amounts(e);
    lines.push([new Date(e.ts).toISOString(), q(e.name), e.key ?? "", { sell: "sold", buy: "bought", list: "listed" }[e.side], e.qty, e.price, a.gross, a.tax, a.fee, a.net, q(e.note)].join(","));
  }
  download(`aion2-ledger-${stamp()}.csv`, lines.join("\n"), "text/csv");
}
async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.entries || []).filter(valid);
    const have = new Set(state.entries.map((e) => e.id));
    const added = incoming.filter((e) => !have.has(e.id)).map((e) => ({
      id: e.id, ts: e.ts, side: e.side, name: shortenName(e.name), key: e.key ?? null, qty: e.qty, price: e.price,
      taxPct: Number.isFinite(e.taxPct) ? e.taxPct : DEFAULTS.taxPct, feePct: Number.isFinite(e.feePct) ? e.feePct : DEFAULTS.feePct,
      note: typeof e.note === "string" ? e.note : "",
      ...(typeof e.listingId === "string" ? { listingId: e.listingId } : {}),
      ...(e.expired ? { expired: true, expiredTs: e.expiredTs } : {}),
    }));
    state.entries.push(...added);
    save({ adjustKinah: false }); // past history, already reflected in the kinah you have
    render();
    toast(added.length ? `Imported ${added.length} entr${added.length === 1 ? "y" : "ies"}.` : "Nothing new to import; those entries are already here.");
  } catch {
    toast("That file isn't a ledger backup.");
  }
}

// "Your kinah" box: shows the shared amount and the last change the log made to it.
function showKinah(delta) {
  const v = readKinah();
  if (document.activeElement !== $("kinah")) $("kinah").value = v == null ? "" : full(v);
  $("kinahNote").innerHTML = v == null
    ? "Set it to have every entry here update the Market Analysis plan."
    : delta ? `Last change: <strong class="${signClass(delta)}">${kinah(delta, { sign: true })}</strong>. Used by the Market Analysis plan.`
      : "Moves with every entry here; used by the Market Analysis plan.";
}

// ---------- toast ----------
let toastTimer;
function toast(msg, action) {
  const t = $("toast");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" id="toastAction">${esc(action)}</button>` : ""}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; undo = null; }, action ? 7000 : 3500);
  if (action) $("toastAction").onclick = () => { undo?.(); undo = null; t.hidden = true; };
}

// ---------- wire up ----------
function init() {
  $("period").innerHTML = PERIODS.map(([v, label]) => `<button type="button" data-v="${v}" aria-pressed="${v === state.period}">${label}</button>`).join("");
  $("period").addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    state.period = b.dataset.v;
    for (const x of $("period").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    render();
  });
  $("side").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setSide(b.dataset.v); });
  $("tax").value = state.settings.taxPct;
  $("listFee").value = state.settings.feePct;
  for (const [id, field] of [["tax", "taxPct"], ["listFee", "feePct"]]) {
    $(id).addEventListener("change", () => {
      const v = Number($(id).value);
      if (Number.isFinite(v) && v >= 0 && v <= 50) { state.settings[field] = v; save(); } else $(id).value = state.settings[field];
      updatePreview();
    });
  }
  for (const id of ["item", "qty", "price", "when"]) $(id).addEventListener("input", updatePreview);
  // Picking an item fills in its current cheapest listing if no price has been typed yet.
  $("item").addEventListener("change", () => {
    if (isMaterials($("item").value) && $("item").value !== MATERIALS) { $("item").value = MATERIALS; if (state.side !== "buy" && !state.editing) setSide("buy"); return updatePreview(); }
    const item = lookup($("item").value);
    if (item && !$("price").value && item.price != null) $("price").value = item.price;
    updatePreview();
  });
  $("entryForm").addEventListener("submit", submit);
  $("cancelEdit").addEventListener("click", () => { resetForm(); render(); });
  $("txTable").addEventListener("click", (ev) => {
    const s = ev.target.closest("[data-sort]");
    if (s) {
      const k = s.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === "name" || k === "note" || k === "side" ? 1 : -1 };
      return render();
    }
    const ed = ev.target.closest("[data-edit]");
    if (ed) { startEdit(ed.dataset.edit); return render(); }
    const del = ev.target.closest("[data-del]");
    if (del) remove(del.dataset.del);
  });
  $("listings").addEventListener("click", (ev) => {
    const sold = ev.target.closest("[data-sold]");
    if (sold) return markSold(sold.dataset.sold, Number($(`sold-${sold.dataset.sold}`).value));
    const exp = ev.target.closest("[data-expire]");
    if (exp) return markExpired(exp.dataset.expire);
    const re = ev.target.closest("[data-relist]");
    if (re) return markExpired(re.dataset.relist, { relist: true });
  });
  $("listings").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.classList.contains("sold-qty")) markSold(ev.target.id.slice(5), Number(ev.target.value));
  });
  // Refresh the "expires in" times every minute.
  setInterval(renderListings, 60e3);
  $("exportJson").addEventListener("click", exportJson);
  $("exportCsv").addEventListener("click", exportCsv);
  $("importFile").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) importJson(f); ev.target.value = ""; });
  // Keep tabs in sync if the log is edited in another tab.
  window.addEventListener("storage", (ev) => {
    if (ev.key === BUDGET_KEY) { showKinah(); return renderPlan(); }
    if (ev.key === "a2dash.planSettings" || ev.key === "a2dash.proficiency") return renderPlan();
    if (ev.key !== STORE_KEY) return;
    // The other tab already moved your kinah for its change; just catch up.
    const s = load(); state.entries = s.entries; state.settings = s.settings; state.lastNet = logNet(state.entries); render();
  });
  state.lastNet = logNet(state.entries);
  showKinah();
  $("kinah").addEventListener("change", () => {
    const raw = $("kinah").value.trim();
    const v = raw ? parseKinah(raw) : null;
    if (raw && !(v >= 0)) { $("kinah").setAttribute("aria-invalid", "true"); return; }
    $("kinah").removeAttribute("aria-invalid");
    writeKinah(v);
    showKinah();
    renderPlan();
  });
  wireCombo();
  setSide("sell");
  resetForm();
  render();
  loadCatalog();
}

init();
