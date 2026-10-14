import { shortenName } from "./metrics.js";

// Profit calculator: a personal log of exchange purchases and sales, kept in this browser (localStorage).
const API = "https://aion2.exchange";
const SNAPSHOT_URL = "data/snapshot.json";
const STORE_KEY = "a2ledger.v1";
const DEFAULTS = { taxPct: 10, feePct: 2 };
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

// "1.5m" -> 1500000, "250k" -> 250000, "1,234,567" -> 1234567. Returns NaN if it can't be read.
export function parseKinah(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[,\s_]/g, "");
  const m = t.match(/^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/);
  if (!m) return NaN;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// Money for one entry. Sales lose tax + listing fee; purchases cost the full price.
export function amounts(e) {
  const gross = e.qty * e.price;
  if (e.side === "buy") return { gross, tax: 0, fee: 0, net: -gross };
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
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ entries: state.entries, settings: state.settings }));
    return true;
  } catch {
    toast("Couldn't save in this browser (private window or storage blocked). Export a backup before closing.");
    return false;
  }
}
function valid(e) {
  return e && typeof e.id === "string" && (e.side === "buy" || e.side === "sell") && Number.isFinite(e.qty) && e.qty > 0
    && Number.isFinite(e.price) && e.price >= 0 && Number.isFinite(e.ts) && typeof e.name === "string";
}
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
};

// ---------- item catalog from the dashboard's snapshot ----------
async function loadCatalog() {
  try {
    const res = await fetch(SNAPSHOT_URL, { cache: "no-cache" });
    const snap = await res.json();
    const market = Object.values(snap.markets || {})[0] || {};
    const icons = market.icons || {};
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
    const names = [...state.catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
    $("itemList").innerHTML = names.map((i) => `<option value="${esc(i.name)}">${i.price != null ? `${kinah(i.price)} listed` : ""}</option>`).join("");
    render();
  } catch { /* the item list is a convenience; typing any name still works */ }
}

function iconHtml(icon, cls = "small") {
  if (!icon) return "";
  const [file, color, rarity] = icon;
  const style = /^#[0-9a-f]{6}$/i.test(color || "") ? ` style="--rarity:${color}"` : "";
  return `<img class="item-icon ${cls}" src="${API}/item-icons/${encodeURIComponent(file)}.webp" alt=""${style} title="${esc(rarity || "")}" loading="lazy" decoding="async" onerror="this.remove()">`;
}
const lookup = (name) => state.catalog.get(String(name || "").trim().toLowerCase());
const iconFor = (e) => (e.key != null && [...state.catalog.values()].find((c) => c.key === e.key)?.icon) || lookup(e.name)?.icon;

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
  return null;
}

function updatePreview() {
  const f = readForm();
  const item = lookup(f.name);
  $("itemIcon").innerHTML = iconHtml(item?.icon, "small");
  const priceHint = item?.price != null ? ` <span class="muted">· cheapest listing now ${full(item.price)}</span>` : "";
  if (!Number.isFinite(f.price) || !(f.qty >= 1)) {
    $("preview").innerHTML = item ? `<span class="muted">${esc(item.name)}</span>${priceHint}` : "";
    return;
  }
  const a = amounts(f);
  $("preview").innerHTML = f.side === "sell"
    ? `${full(a.gross)} − tax ${full(a.tax)} (${f.taxPct}%) − listing fee ${full(a.fee)} (${f.feePct}%) = <strong class="pos">you receive ${full(a.net)}</strong>${priceHint}`
    : `<strong class="neg">You pay ${full(a.gross)}</strong> <span class="muted">(${f.qty} × ${full(f.price)})</span>${priceHint}`;
}

function submit(ev) {
  ev.preventDefault();
  const f = readForm();
  const problem = formProblem(f);
  $("formError").hidden = !problem;
  $("formError").textContent = problem || "";
  if (problem) return;
  const item = lookup(f.name);
  const entry = { ...f, name: item?.name || f.name, key: item?.key ?? null };
  if (state.editing) {
    const i = state.entries.findIndex((x) => x.id === state.editing);
    if (i >= 0) state.entries[i] = { ...state.entries[i], ...entry };
    toast("Entry updated.");
  } else {
    state.entries.push({ id: newId(), ...entry });
    toast(`${f.side === "sell" ? "Sale" : "Purchase"} added: ${f.qty} × ${entry.name}.`);
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
  if (state.editing === id) resetForm();
  save();
  render();
  undo = () => { state.entries.push(gone); save(); render(); };
  toast(`Deleted ${gone.qty} × ${gone.name}.`, "Undo");
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
  const t = { received: 0, spent: 0, tax: 0, fee: 0, sold: 0, bought: 0 };
  for (const e of entries) {
    const a = amounts(e);
    if (e.side === "sell") { t.received += a.net; t.tax += a.tax; t.fee += a.fee; t.sold += e.qty; }
    else { t.spent += a.gross; t.bought += e.qty; }
  }
  t.profit = t.received - t.spent;
  return t;
}

function byItem(entries) {
  const groups = new Map();
  for (const e of entries) {
    const k = e.name.toLowerCase();
    if (!groups.has(k)) groups.set(k, { name: e.name, key: e.key, icon: iconFor(e), list: [] });
    groups.get(k).list.push(e);
  }
  return [...groups.values()].map((g) => {
    const t = totals(g.list);
    const buys = g.list.filter((e) => e.side === "buy"), sells = g.list.filter((e) => e.side === "sell");
    const avg = (list) => (list.length ? list.reduce((s, e) => s + e.qty * e.price, 0) / list.reduce((s, e) => s + e.qty, 0) : null);
    return { ...g, ...t, avgBuy: avg(buys), avgSell: avg(sells), onHand: t.bought - t.sold, last: Math.max(...g.list.map((e) => e.ts)) };
  }).sort((a, b) => b.profit - a.profit);
}

// ---------- render ----------
function render() {
  const entries = state.entries.filter(inPeriod);
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
    kpi("Spent buying", kinah(t.spent), `${t.bought.toLocaleString()} bought`),
    kpi("Tax and fees paid", kinah(t.tax + t.fee), `${kinah(t.tax)} tax · ${kinah(t.fee)} listing fees`),
  ].join("");
}

function renderByItem(entries) {
  const rows = byItem(entries);
  $("byItem").querySelector("thead").innerHTML = `<tr><th>Item</th><th>Bought</th><th>Avg buy</th><th>Spent</th><th>Sold</th><th>Avg sell</th><th>Received</th><th>Profit</th><th>On hand</th></tr>`;
  $("byItem").querySelector("tbody").innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td class="name"><span class="item-cell">${iconHtml(r.icon, "")}<span class="item-text"><strong>${esc(r.name)}</strong></span></span></td>
        <td>${r.bought ? r.bought.toLocaleString() : "—"}</td>
        <td>${kinah(r.avgBuy)}</td>
        <td>${r.spent ? kinah(r.spent) : "—"}</td>
        <td>${r.sold ? r.sold.toLocaleString() : "—"}</td>
        <td>${kinah(r.avgSell)}</td>
        <td>${r.received ? kinah(r.received) : "—"}</td>
        <td class="${signClass(r.profit)}" title="${full(r.profit)}">${kinah(r.profit, { sign: true })}</td>
        <td class="${r.onHand < 0 ? "dim" : ""}">${r.onHand.toLocaleString()}</td>
      </tr>`).join("")
    : `<tr><td colspan="9" class="empty-row">${state.entries.length ? "No transactions in this period." : "Nothing logged yet. Add your first purchase or sale above."}</td></tr>`;
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
        <td class="name"><span class="item-cell">${iconHtml(iconFor(e))}<span>${esc(e.name)}</span></span></td>
        <td><span class="pill ${e.side === "sell" ? "good sold" : "neutral bought"}">${e.side === "sell" ? "Sold" : "Bought"}</span></td>
        <td>${e.qty.toLocaleString()}</td>
        <td title="${full(e.price)}">${kinah(e.price)}</td>
        <td title="${full(a.gross)}">${kinah(a.gross)}</td>
        <td title="${e.side === "sell" ? `Tax ${full(a.tax)} (${e.taxPct}%) + listing fee ${full(a.fee)} (${e.feePct}%)` : "No tax on purchases"}">${e.side === "sell" ? kinah(a.tax + a.fee) : "—"}</td>
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
    lines.push([new Date(e.ts).toISOString(), q(e.name), e.key ?? "", e.side === "sell" ? "sold" : "bought", e.qty, e.price, a.gross, a.tax, a.fee, a.net, q(e.note)].join(","));
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
    }));
    state.entries.push(...added);
    save();
    render();
    toast(added.length ? `Imported ${added.length} entr${added.length === 1 ? "y" : "ies"}.` : "Nothing new to import; those entries are already here.");
  } catch {
    toast("That file isn't a ledger backup.");
  }
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
  $("exportJson").addEventListener("click", exportJson);
  $("exportCsv").addEventListener("click", exportCsv);
  $("importFile").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) importJson(f); ev.target.value = ""; });
  // Keep tabs in sync if the log is edited in another tab.
  window.addEventListener("storage", (ev) => {
    if (ev.key !== STORE_KEY) return;
    const s = load(); state.entries = s.entries; state.settings = s.settings; render();
  });
  setSide("sell");
  resetForm();
  render();
  loadCatalog();
}

init();
