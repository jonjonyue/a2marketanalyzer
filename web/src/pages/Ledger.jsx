import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { shortenName, parseKinah, analyzeMarket, DEFAULT_SETTINGS } from "../lib/metrics.js";
import { kinah, full, signClass, cx } from "../lib/format.js";
import { KEYS, readRaw, readJson, writeRaw, writeKinah, useKinah, useStoredRaw } from "../lib/storage.js";
import { DEFAULT_SERVER, serverLabel, useServerDoc, useSnapshot } from "../lib/data.js";
import { ItemIcon } from "../components/ItemIcon.jsx";
import { planView } from "../components/Plan.jsx";
import { LedgerMethod } from "./LedgerMethod.jsx";

// Profit calculator: a personal log of exchange purchases, listings and sales, kept in this browser (localStorage).
const DEFAULTS = { taxPct: 10, feePct: 2 };
// A catch-all item for crafting materials bought, so their cost counts against profit without logging each one.
const MATERIALS = "Materials";
const isMaterials = (name) => String(name || "").trim().toLowerCase() === MATERIALS.toLowerCase();
const PERIODS = [["all", "All time"], ["30", "30 days"], ["7", "7 days"], ["1", "Today"]];
const LISTING_HOURS = 72; // exchange listings last 3 days
const SIDE_LABEL = { sell: "Sale", buy: "Purchase", list: "Listing" };

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
const logNet = (entries) => entries.reduce((t, e) => t + amounts(e).net, 0);

function valid(e) {
  return e && typeof e.id === "string" && (e.side === "buy" || e.side === "sell" || e.side === "list") && Number.isFinite(e.qty) && e.qty > 0
    && Number.isFinite(e.price) && e.price >= 0 && Number.isFinite(e.ts) && typeof e.name === "string";
}
function load() {
  const raw = readJson(KEYS.ledger);
  if (raw && Array.isArray(raw.entries)) return { entries: raw.entries.filter(valid).map((e) => ({ ...e, name: shortenName(e.name) })), settings: { ...DEFAULTS, ...raw.settings } };
  return { entries: [], settings: { ...DEFAULTS } };
}
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// Listing helpers over a list of entries.
const soldQty = (entries, listing, except = null) => entries.filter((x) => x.side === "sell" && x.listingId === listing.id && x.id !== except).reduce((n, x) => n + x.qty, 0);
const remaining = (entries, listing) => Math.max(0, listing.qty - soldQty(entries, listing));
const isActive = (entries, e) => e.side === "list" && !e.expired && remaining(entries, e) > 0;

function localInputValue(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function timeLeft(l, now) {
  const ms = l.ts + LISTING_HOURS * 3600e3 - now;
  const h = Math.abs(ms) / 3600e3;
  const txt = h >= 24 ? `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h` : h >= 1 ? `${Math.floor(h)}h` : `${Math.max(1, Math.round(h * 60))}m`;
  return ms > 0 ? { text: `in ${txt}`, over: false } : { text: `${txt} ago`, over: true };
}

function inPeriod(e, period) {
  if (period === "all") return true;
  if (period === "1") { const start = new Date(); start.setHours(0, 0, 0, 0); return e.ts >= start.getTime(); }
  return e.ts >= Date.now() - Number(period) * 86400e3;
}

function totals(entries) {
  const t = { received: 0, spent: 0, tax: 0, fee: 0, sold: 0, bought: 0, listingFees: 0, profit: 0, materials: 0 };
  for (const e of entries) {
    const a = amounts(e);
    t.profit += a.net;
    if (e.side === "sell") { t.received += a.net; t.tax += a.tax; t.fee += a.fee; t.sold += e.qty; }
    else if (e.side === "list") { t.fee += a.fee; t.listingFees += a.fee; }
    else { t.spent += a.gross; t.bought += e.qty; if (isMaterials(e.name)) t.materials += a.gross; }
  }
  return t;
}

// The plan uses the settings last used on Market Analysis (filters, share of sales, price basis, proficiency) in this browser.
function planSettings(savedRaw, profRaw) {
  let saved = {}, prof = {};
  try { saved = JSON.parse(savedRaw || "null") || {}; } catch { /* defaults */ }
  try { prof = JSON.parse(profRaw || "null") || {}; } catch { /* defaults */ }
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

// Item catalog for the search box: every item in the market snapshot, plus names already in the log.
function buildCatalog(market, entries) {
  const catalog = new Map(); // lowercase name -> { key, name, price, icon }
  const icons = market?.icons || {};
  const add = (key, rawName, price) => {
    const name = shortenName(rawName);
    if (!name) return;
    const k = name.toLowerCase();
    const prev = catalog.get(k);
    if (!prev || (prev.price == null && price != null)) catalog.set(k, { key, name, price: price ?? null, icon: icons[key] });
  };
  if (market) {
    const itemPrice = new Map((market.items || []).map((i) => [i.item_key, i.price]));
    for (const t of market.targets || []) add(t.target_key, t.name, itemPrice.get(t.target_key) ?? t.market_price);
    for (const m of market.materials || []) add(m.item_key, m.name, m.price);
    for (const c of Object.values(market.chains || {})) {
      for (const tr of c.tiers || []) add(tr.item_key, tr.name, tr.market_price);
      for (const s of c.steps || []) for (const m of s.materials || []) add(m.material_key, m.name, m.listing_price);
    }
  }
  for (const e of entries) if (!catalog.has(e.name.toLowerCase())) add(e.key ?? null, e.name, null);
  const options = [...catalog.values()].filter((i) => !isMaterials(i.name)).sort((a, b) => a.name.localeCompare(b.name));
  return { catalog, options };
}

// ---------- item search dropdown ----------
const MAX_RESULTS = 60;
const MAT_OPTION = { name: MATERIALS, label: "Crafting materials (any)", materials: true };
function matches(options, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [MAT_OPTION, ...options.slice(0, MAX_RESULTS)];
  const scored = [];
  for (const i of options) {
    const n = i.name.toLowerCase();
    if (!words.every((w) => n.includes(w))) continue;
    scored.push([n.startsWith(words[0]) ? 0 : n.includes(" " + words[0]) ? 1 : 2, i]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  const out = scored.slice(0, MAX_RESULTS).map(([, i]) => i);
  if (words.every((w) => "materials crafting".includes(w) || MATERIALS.toLowerCase().startsWith(w))) out.unshift(MAT_OPTION);
  return out;
}
function Highlight({ name, query }) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return name;
  const lower = name.toLowerCase();
  const marks = new Array(name.length).fill(false);
  for (const w of words) { const i = lower.indexOf(w); if (i >= 0) for (let k = i; k < i + w.length; k++) marks[k] = true; }
  const parts = [];
  let start = 0;
  for (let k = 1; k <= name.length; k++) {
    if (k === name.length || marks[k] !== marks[start]) {
      const text = name.slice(start, k);
      parts.push(marks[start] ? <mark key={start}>{text}</mark> : text);
      start = k;
    }
  }
  return parts;
}

const MatIcon = ({ size = "small" }) => <span className={`mat-icon ${size}`.trim()} aria-hidden="true">⚒</span>;
// Icon for a logged entry or item group; Materials gets its own badge. The icon lookup comes from context.
const IconLookup = createContext(() => null);
function EntryIcon({ e, size = "small" }) {
  const iconFor = useContext(IconLookup);
  return isMaterials(e.name) ? <MatIcon size={size} /> : <ItemIcon icon={iconFor(e)} size={size} />;
}

function ItemCombo({ value, onChange, onPick, options, inputRef }) {
  const [menu, setMenu] = useState({ open: false, active: -1 });
  const listRef = useRef(null);
  const items = useMemo(() => (menu.open ? matches(options, value.trim()) : []), [menu.open, options, value]);
  const open = () => setMenu((m) => (m.open ? m : { open: true, active: -1 }));
  const close = () => setMenu({ open: false, active: -1 });
  const pick = (name) => { close(); onPick(name); };
  const move = (delta) => setMenu((m) => {
    const n = matches(options, value.trim()).length;
    if (!n) return { open: true, active: -1 };
    const active = ((m.open ? m.active : -1) + delta + n) % n;
    requestAnimationFrame(() => listRef.current?.querySelector(`#opt-${active}`)?.scrollIntoView({ block: "nearest" }));
    return { open: true, active };
  });
  const q = value.trim();
  return (
    <div className="item-input combo">
      <span className="item-input-icon" id="itemIcon">{isMaterials(value) ? <MatIcon /> : <ItemIcon icon={options.find((o) => o.name.toLowerCase() === q.toLowerCase())?.icon} size="small" />}</span>
      <input id="item" ref={inputRef} type="text" role="combobox" aria-autocomplete="list" aria-expanded={menu.open} aria-controls="itemMenu"
        aria-activedescendant={menu.open && menu.active >= 0 ? `opt-${menu.active}` : undefined}
        placeholder="Search items or type any name" spellCheck="false" required value={value}
        onFocus={open} onClick={open} onBlur={() => setTimeout(close, 0)}
        onChange={(e) => { onChange(e.target.value); setMenu((m) => ({ open: true, active: m.open ? -1 : -1 })); }}
        onKeyDown={(ev) => {
          if (ev.key === "ArrowDown") { ev.preventDefault(); move(1); }
          else if (ev.key === "ArrowUp") { ev.preventDefault(); move(-1); }
          else if (ev.key === "Enter" && menu.open && menu.active >= 0 && items[menu.active]) { ev.preventDefault(); pick(items[menu.active].name); }
          else if (ev.key === "Escape" && menu.open) { ev.preventDefault(); close(); }
          else if (ev.key === "Tab") close();
        }} />
      <span className="combo-caret" aria-hidden="true">▾</span>
      <ul className="combo-menu" id="itemMenu" role="listbox" aria-label="Items" hidden={!menu.open} ref={listRef}
        onMouseDown={(ev) => {
          // mousedown (not click) so the pick happens before the input loses focus
          ev.preventDefault();
          const li = ev.target.closest("[role=option]");
          if (li) pick(items[Number(li.dataset.idx)].name);
        }}>
        {menu.open && (items.length ? items.map((i, idx) => (
          <li key={i.name} role="option" id={`opt-${idx}`} data-idx={idx} aria-selected={idx === menu.active}>
            {i.materials ? <MatIcon /> : i.icon ? <ItemIcon icon={i.icon} size="small" /> : <span className="icon-gap"></span>}
            <span className="opt-name">{i.materials ? <><strong>{i.name}</strong> <span className="muted">· {i.label}</span></> : <Highlight name={i.name} query={q} />}</span>
            <span className="opt-price">{i.price != null ? kinah(i.price) : ""}</span>
          </li>
        )) : <li className="combo-empty">No match. "{q}" will be logged as a new item.</li>)}
      </ul>
    </div>
  );
}

// ---------- page ----------
const emptyForm = () => ({ item: "", qty: "1", price: "", when: localInputValue(Date.now()), note: "" });

export default function Ledger() {
  const [log, setLog] = useState(load);
  const logRef = useRef(log);
  logRef.current = log;
  const entries = log.entries;
  const [period, setPeriod] = useState("all");
  const [side, setSide] = useState("sell");
  const [editing, setEditing] = useState(null); // id of the entry being edited
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState(null);
  const [sort, setSort] = useState({ key: "ts", dir: -1 });
  const [lastDelta, setLastDelta] = useState(0);
  const [toast, setToast] = useState(null); // { msg, action, undo }
  const [now, setNow] = useState(Date.now());
  const itemRef = useRef(null), priceRef = useRef(null), qtyRef = useRef(null), formRef = useRef(null);
  const have = useKinah();

  // Refresh the "expires in" times every minute.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60e3); return () => clearInterval(t); }, []);
  // Keep in sync if the log is edited in another tab (that tab already moved your kinah for its change).
  useEffect(() => {
    const f = (ev) => { if (ev.key === KEYS.ledger) setLog(load()); };
    window.addEventListener("storage", f);
    return () => window.removeEventListener("storage", f);
  }, []);

  // Market data for item names, prices, icons and the plan: the server picked on Market Analysis.
  const { snapshot } = useSnapshot();
  const savedSid = parseInt(useStoredRaw(KEYS.server), 10) || DEFAULT_SERVER;
  const servers = snapshot?.servers || [];
  const srv = servers.find((x) => x.server_id === savedSid) || servers.find((x) => x.server_id === snapshot?.default_server) || servers[0];
  const { doc } = useServerDoc(snapshot, srv?.server_id ?? null);
  const market = doc?.market || null;
  const { catalog, options } = useMemo(() => buildCatalog(market, entries), [market, entries]);
  const lookup = (name) => catalog.get(String(name || "").trim().toLowerCase());
  const iconFor = (e) => (e.key != null && options.find((c) => c.key === e.key)?.icon) || lookup(e.name)?.icon;

  // ---------- saving ----------
  function showToast(msg, undo) {
    setToast({ msg, action: undo ? "Undo" : null, undo, id: Date.now() });
  }
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.action ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  /** Save a new log. Unless it's an import, your kinah moves by the change's kinah effect. */
  function commit(next, { adjustKinah = true } = {}) {
    const prev = logRef.current;
    const nextLog = { entries: next.entries ?? prev.entries, settings: next.settings ?? prev.settings };
    logRef.current = nextLog;
    setLog(nextLog);
    if (!writeRaw(KEYS.ledger, JSON.stringify(nextLog))) {
      showToast("Couldn't save in this browser (private window or storage blocked). Export a backup before closing.");
      return;
    }
    const delta = logNet(nextLog.entries) - logNet(prev.entries);
    const kinahNow = parseKinah(readRaw(KEYS.budget));
    if (adjustKinah && delta && Number.isFinite(kinahNow)) {
      writeKinah(kinahNow + delta);
      setLastDelta(delta);
    }
  }

  // ---------- form ----------
  const editingEntry = editing && entries.find((x) => x.id === editing);
  const f = {
    name: shortenName(form.item.trim()), qty: Number(form.qty), price: parseKinah(form.price),
    ts: form.when ? new Date(form.when).getTime() : Date.now(),
    taxPct: editingEntry ? editingEntry.taxPct : log.settings.taxPct, feePct: editingEntry ? editingEntry.feePct : log.settings.feePct,
    side, note: form.note.trim(),
  };
  const setField = (k, v) => setForm((x) => ({ ...x, [k]: v }));

  function formProblem() {
    if (!f.name) return "Pick or type an item.";
    if (!Number.isInteger(f.qty) || f.qty < 1) return "Quantity must be a whole number, 1 or more.";
    if (!Number.isFinite(f.price) || f.price < 0) return "Price must be a number, like 1500000, 1.5m or 250k.";
    if (!Number.isFinite(f.ts)) return "Pick a date.";
    if (editingEntry?.listingId) {
      const listing = entries.find((x) => x.id === editingEntry.listingId);
      if (f.side !== "sell") return "This sale came from a listing. Delete it instead to undo the sale.";
      if (listing && f.qty > listing.qty - soldQty(entries, listing, editingEntry.id)) return `Only ${listing.qty - soldQty(entries, listing, editingEntry.id)} left on that listing.`;
    }
    if (editingEntry?.side === "list") {
      const sold = soldQty(entries, editingEntry);
      if (sold && f.side !== "list") return "This listing has sales logged against it. Delete those first to change its type.";
      if (f.qty < sold) return `${sold} of this listing are already marked sold, so the quantity can't go below that.`;
    }
    return null;
  }

  function resetForm({ keepItem = false } = {}) {
    setEditing(null);
    setForm((x) => ({ ...emptyForm(), item: keepItem ? x.item : "" }));
    setFormError(null);
  }

  function submit(ev) {
    ev.preventDefault();
    const problem = formProblem();
    setFormError(problem);
    if (problem) return;
    const item = lookup(f.name);
    const entry = { ...f, name: isMaterials(f.name) ? MATERIALS : item?.name || f.name, key: isMaterials(f.name) ? null : item?.key ?? null };
    if (editing) {
      commit({ entries: entries.map((x) => (x.id === editing ? { ...x, ...entry } : x)) });
      showToast("Entry updated.");
    } else {
      commit({ entries: [...entries, { id: newId(), ...entry }] });
      showToast(isMaterials(entry.name) && side === "buy"
        ? `Materials added: ${full(amounts(entry).gross)} spent.`
        : `${SIDE_LABEL[side]} added: ${f.qty} × ${entry.name}.`);
    }
    resetForm({ keepItem: !editing });
  }

  function pickItem(name) {
    let price = form.price;
    if (isMaterials(name)) {
      if (side !== "buy" && !editing) setSide("buy");
    } else {
      const item = lookup(name);
      if (item && !price && item.price != null) price = String(item.price);
    }
    setForm((x) => ({ ...x, item: name, price: x.price || price }));
    requestAnimationFrame(() => (isMaterials(name) || !price ? priceRef : qtyRef).current?.focus());
  }
  // Leaving the box: "materials" in any spelling is the catch-all; a known item fills in its cheapest listing.
  function itemBlur() {
    // Read the latest form (not this render's copy), so a price typed meanwhile is never overwritten.
    if (isMaterials(form.item) && side !== "buy" && !editing) setSide("buy");
    setForm((x) => {
      if (isMaterials(x.item)) return x.item === MATERIALS ? x : { ...x, item: MATERIALS };
      const item = lookup(x.item);
      return item && !x.price && item.price != null ? { ...x, price: String(item.price) } : x;
    });
  }

  function startEdit(id) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    setEditing(id);
    setSide(e.side);
    setForm({ item: e.name, qty: String(e.qty), price: String(e.price), when: localInputValue(e.ts), note: e.note || "" });
    setFormError(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    priceRef.current?.focus({ preventScroll: true });
  }

  function remove(id) {
    const gone = entries.find((x) => x.id === id);
    if (!gone) return;
    // Deleting a listing also deletes the sales marked against it.
    const linked = gone.side === "list" ? entries.filter((x) => x.listingId === gone.id) : [];
    const goneIds = new Set([gone.id, ...linked.map((x) => x.id)]);
    commit({ entries: entries.filter((x) => !goneIds.has(x.id)) });
    if (goneIds.has(editing)) resetForm();
    showToast(`Deleted ${gone.qty} × ${gone.name}${linked.length ? ` and its ${linked.length} sale${linked.length > 1 ? "s" : ""}` : ""}.`,
      () => commit({ entries: [...logRef.current.entries, gone, ...linked] }));
  }

  // ---------- listings ----------
  function markSold(id, qty) {
    const l = entries.find((x) => x.id === id);
    if (!l) return;
    const left = remaining(entries, l);
    if (!Number.isInteger(qty) || qty < 1 || qty > left) return showToast(`Enter how many sold, 1 to ${left}.`);
    const sale = { id: newId(), side: "sell", listingId: l.id, name: l.name, key: l.key ?? null, qty, price: l.price, taxPct: l.taxPct, feePct: 0, ts: Date.now(), note: "" };
    commit({ entries: [...entries, sale] });
    showToast(`Sold ${qty} × ${l.name}: +${full(amounts(sale).net)} after tax.`,
      () => commit({ entries: logRef.current.entries.filter((x) => x.id !== sale.id) }));
  }

  function markExpired(id, { relist = false } = {}) {
    const l = entries.find((x) => x.id === id);
    if (!l) return;
    const left = remaining(entries, l);
    const fresh = relist && left > 0
      ? { id: newId(), side: "list", name: l.name, key: l.key ?? null, qty: left, price: l.price, taxPct: log.settings.taxPct, feePct: log.settings.feePct, ts: Date.now(), note: l.note || "" }
      : null;
    commit({ entries: [...entries.map((x) => (x.id === id ? { ...x, expired: true, expiredTs: Date.now() } : x)), ...(fresh ? [fresh] : [])] });
    showToast(fresh ? `Relisted ${left} × ${l.name}: new listing fee ${full(amounts(fresh).fee)}.` : `Marked ${left} × ${l.name} as expired; the listing fee is lost.`,
      () => commit({ entries: logRef.current.entries
        .filter((x) => !fresh || x.id !== fresh.id)
        .map((x) => { if (x.id !== id) return x; const { expired, expiredTs, ...rest } = x; return rest; }) }));
  }

  // ---------- backup ----------
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  const exportJson = () => download(`aion2-ledger-${stamp()}.json`, JSON.stringify({ version: 1, exported_at: new Date().toISOString(), entries }, null, 2), "application/json");
  function exportCsv() {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["date", "item", "item_key", "type", "qty", "price_each", "total", "tax", "listing_fee", "kinah_change", "note"].join(",")];
    for (const e of [...entries].sort((a, b) => a.ts - b.ts)) {
      const a = amounts(e);
      lines.push([new Date(e.ts).toISOString(), q(e.name), e.key ?? "", { sell: "sold", buy: "bought", list: "listed" }[e.side], e.qty, e.price, a.gross, a.tax, a.fee, a.net, q(e.note)].join(","));
    }
    download(`aion2-ledger-${stamp()}.csv`, lines.join("\n"), "text/csv");
  }
  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data.entries || []).filter(valid);
      const known = new Set(logRef.current.entries.map((e) => e.id));
      const added = incoming.filter((e) => !known.has(e.id)).map((e) => ({
        id: e.id, ts: e.ts, side: e.side, name: shortenName(e.name), key: e.key ?? null, qty: e.qty, price: e.price,
        taxPct: Number.isFinite(e.taxPct) ? e.taxPct : DEFAULTS.taxPct, feePct: Number.isFinite(e.feePct) ? e.feePct : DEFAULTS.feePct,
        note: typeof e.note === "string" ? e.note : "",
        ...(typeof e.listingId === "string" ? { listingId: e.listingId } : {}),
        ...(e.expired ? { expired: true, expiredTs: e.expiredTs } : {}),
      }));
      commit({ entries: [...logRef.current.entries, ...added] }, { adjustKinah: false }); // past history, already reflected in your kinah
      showToast(added.length ? `Imported ${added.length} entr${added.length === 1 ? "y" : "ies"}.` : "Nothing new to import; those entries are already here.");
    } catch {
      showToast("That file isn't a ledger backup.");
    }
  }

  // ---------- plan ----------
  const planRaw = useStoredRaw(KEYS.planSettings);
  const profRaw = useStoredRaw(KEYS.proficiency);
  const { settings, tier, skill } = useMemo(() => planSettings(planRaw, profRaw), [planRaw, profRaw]);
  const planRows = useMemo(() => {
    if (!market) return null;
    let rows = analyzeMarket(market, settings);
    if (tier !== "All") rows = rows.filter((r) => r.tier === tier);
    if (skill !== "All") rows = rows.filter((r) => r.skill === skill);
    return rows;
  }, [market, settings, tier, skill]);
  const filters = [tier !== "All" && tier, skill !== "All" && skill].filter(Boolean).join(", ");
  const plan = planRows && planView({
    rows: planRows, budget: have > 0 ? have : null, settings, serverName: srv?.name, snapshotAt: market.captured_at, icons: market.icons, entries,
    scope: `with your Market Analysis settings${filters ? ` (${filters})` : ""}`,
    emptyHint: "Enter your kinah below (next to the tax and fee settings) to see what to craft with it.",
  });

  // ---------- derived views ----------
  const inView = entries.filter((e) => inPeriod(e, period));
  const t = totals(inView);
  const periodLabel = PERIODS.find(([v]) => v === period)[1].toLowerCase();
  const active = entries.filter((e) => isActive(entries, e)).sort((a, b) => a.ts - b.ts);
  const item = lookup(f.name);

  return <IconLookup.Provider value={iconFor}>
    <div className="wip-banner" role="note">
      <div className="wrap wip-inner">
        <span className="wip-icon" aria-hidden="true">!</span>
        <div>
          <strong>Work in progress</strong>
          <p>This page is still being built. Features may change, so export a backup of anything you log here.</p>
        </div>
      </div>
    </div>

    <header className="top">
      <div className="wrap top-inner">
        <div>
          <p className="eyebrow">Aion 2 · Transaction tracker · <span id="serverName" title="Item prices are from this server; change it on the Market Analysis page">{srv ? serverLabel(srv) : "Siel · Elyos · North America West"}</span></p>
          <h1>Profit calculator</h1>
          <p className="lede">Log what you buy and sell at the price you listed or paid. Sales tax and the listing fee are taken off sales for you, so the totals are the kinah you actually made or lost.</p>
        </div>
        <div className="freshness" title="Entries are saved in this browser only. Use Export below to back them up or move them to another device."><span className="dot"></span>Saved in this browser</div>
      </div>
    </header>

    <main className="wrap">
      <section className="panel plan ledger-plan" aria-labelledby="planTitle">
        <div className="table-head">
          <h2 id="planTitle">What to craft with your kinah</h2>
          <p className="muted"><span id="planNote">{plan?.note}</span> <a href="#/">Change settings on Market Analysis</a></p>
        </div>
        <div id="planBody">{plan ? plan.body : <p className="muted plan-empty">Loading market data…</p>}</div>
      </section>

      <form className="panel entry-form" id="entryForm" ref={formRef} autoComplete="off" noValidate onSubmit={submit}>
        <div className="form-head">
          <h2 id="formTitle">{editing ? "Edit transaction" : "Add a transaction"}</h2>
          <button type="button" className="text-btn" id="cancelEdit" hidden={!editing} onClick={() => resetForm()}>Cancel edit</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <span>Type</span>
            <div className="seg side-seg" id="side" role="radiogroup" aria-label="Bought, listed or sold" data-side={side}>
              {[["buy", "Bought"], ["list", "Listed"], ["sell", "Sold"]].map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={side === v} onClick={() => setSide(v)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="field item-field" onBlur={(e) => { if (e.target.id === "item") itemBlur(); }}>
            <label htmlFor="item">Item</label>
            <ItemCombo value={form.item} onChange={(v) => setField("item", v)} onPick={pickItem} options={options} inputRef={itemRef} />
          </div>
          <label className="field">
            <span>Quantity</span>
            <input id="qty" ref={qtyRef} type="number" min="1" step="1" inputMode="numeric" required value={form.qty} onChange={(e) => setField("qty", e.target.value)} />
          </label>
          <label className="field">
            <span>Price each</span>
            <input id="price" ref={priceRef} type="text" inputMode="decimal" placeholder="e.g. 1.5m or 250k" required value={form.price} onChange={(e) => setField("price", e.target.value)} />
          </label>
          <label className="field">
            <span>Date</span>
            <input id="when" type="datetime-local" required value={form.when} onChange={(e) => setField("when", e.target.value)} />
          </label>
          <label className="field note-field">
            <span>Note <em className="opt">optional</em></span>
            <input id="note" type="text" maxLength={120} placeholder="e.g. crafted, flipped, bulk" value={form.note} onChange={(e) => setField("note", e.target.value)} />
          </label>
          <button className="link-btn add-btn" id="submitBtn" type="submit">{editing ? "Save" : "Add"}</button>
        </div>
        <p className="preview" id="preview" aria-live="polite"><Preview f={f} item={item} /></p>
        <p className="form-error" id="formError" role="alert" hidden={!formError}>{formError}</p>
      </form>

      {active.length > 0 && (
        <Listings active={active} entries={entries} now={now}
          onSold={markSold} onExpire={(id) => markExpired(id)} onRelist={(id) => markExpired(id, { relist: true })} />
      )}

      <section className="controls ledger-controls" aria-label="Your kinah, period and fees">
        <KinahField have={have} lastDelta={lastDelta} />
        <div className="field">
          <span>Period</span>
          <div className="chips" id="period" role="group" aria-label="Period">
            {PERIODS.map(([v, label]) => <button key={v} type="button" aria-pressed={v === period} onClick={() => setPeriod(v)}>{label}</button>)}
          </div>
        </div>
        {[["tax", "taxPct", "Sales tax %"], ["listFee", "feePct", "Listing fee %"]].map(([id, field, label]) => (
          <label className="field small" key={id}>
            <span>{label}</span>
            <input id={id} type="number" min="0" max="50" step="0.5" inputMode="decimal" key={log.settings[field]} defaultValue={log.settings[field]}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0 && v <= 50) { if (v !== log.settings[field]) commit({ settings: { ...log.settings, [field]: v } }); }
                else e.target.value = log.settings[field];
              }} />
          </label>
        ))}
        <p className="muted fee-note">Tax and fee apply to new entries; each entry keeps the rates it was logged with.</p>
      </section>

      <section className="kpis" id="kpis" aria-label="Totals">
        {[
          [t.profit >= 0 ? "Kinah made" : "Kinah lost", kinah(t.profit, { sign: true }), `${full(t.profit)} · ${periodLabel}`, signClass(t.profit)],
          ["Received from sales", kinah(t.received), `${t.sold.toLocaleString()} sold, after tax and fees`],
          ["Spent buying", kinah(t.spent), t.materials ? `${kinah(t.materials)} on crafting materials` : `${t.bought.toLocaleString()} bought`],
          ["Tax and fees paid", kinah(t.tax + t.fee), `${kinah(t.tax)} tax · ${kinah(t.fee)} listing fees`],
        ].map(([label, value, sub, cls]) => (
          <div className="kpi" key={label}><div className="label">{label}</div><div className={cx("value", cls)}>{value}</div><div className="sub">{sub}</div></div>
        ))}
      </section>

      <section className="panel table-panel">
        <div className="table-head">
          <h2>By item</h2>
          <p className="muted">Profit = kinah received from sales − kinah spent buying − listing fees. "Listed" is what is on the market now; "On hand" is bought − sold − listed.</p>
        </div>
        <div className="table-scroll"><ByItem inView={inView} entries={entries} /></div>
      </section>

      <section className="panel table-panel">
        <div className="table-head">
          <h2>Transactions</h2>
          <p className="muted" id="txNote">{inView.length ? `${inView.length} of ${entries.length} entries. Hover an amount for the exact figure.` : ""}</p>
        </div>
        <div className="table-scroll">
          <Transactions inView={inView} entries={entries} sort={sort} setSort={setSort} editing={editing} onEdit={startEdit} onDelete={remove} />
        </div>
      </section>

      <section className="panel backup">
        <div>
          <h2>Back up or move your log</h2>
          <p className="muted">Your entries live only in this browser. Export a file to keep a backup or to load them on another device; importing adds entries you don't already have.</p>
        </div>
        <div className="backup-actions">
          <button type="button" className="ext-button" id="exportJson" onClick={exportJson}>Export backup (.json)</button>
          <button type="button" className="ext-button" id="exportCsv" onClick={exportCsv}>Export spreadsheet (.csv)</button>
          <label className="ext-button file-btn">Import backup<input type="file" id="importFile" accept="application/json,.json" hidden
            onChange={(ev) => { const file = ev.target.files[0]; if (file) importJson(file); ev.target.value = ""; }} /></label>
        </div>
      </section>

      <LedgerMethod />
    </main>

    <footer className="wrap foot">
      Item list and prices from <a href="https://aion2.exchange" target="_blank" rel="noopener">aion2.exchange</a>. Not affiliated with NCSOFT.
    </footer>

    <div className="toast" id="toast" role="status" hidden={!toast}>
      {toast && <>
        <span>{toast.msg}</span>
        {toast.action && <button type="button" id="toastAction" onClick={() => { toast.undo?.(); setToast(null); }}>{toast.action}</button>}
      </>}
    </div>
  </IconLookup.Provider>;
}

function Preview({ f, item }) {
  const priceHint = item?.price != null ? <> <span className="muted">· cheapest listing now {full(item.price)}</span></> : null;
  if (!Number.isFinite(f.price) || !(f.qty >= 1)) return item ? <><span className="muted">{item.name}</span>{priceHint}</> : null;
  const a = amounts(f);
  if (f.side === "list") {
    const tax = Math.round(a.gross * f.taxPct / 100);
    return <><strong className="neg">Listing fee {full(a.fee)}</strong> ({f.feePct}% of {full(a.gross)}) paid now ·{" "}
      if it all sells you receive <strong className="pos">{full(a.gross - tax)}</strong> after {f.taxPct}% tax{priceHint}</>;
  }
  if (f.side === "sell") {
    return <>{full(a.gross)} − tax {full(a.tax)} ({f.taxPct}%){f.feePct ? ` − listing fee ${full(a.fee)} (${f.feePct}%)` : " (listing fee already paid)"} = <strong className="pos">you receive {full(a.net)}</strong>{priceHint}</>;
  }
  return <><strong className="neg">You pay {full(a.gross)}</strong> <span className="muted">({f.qty} × {full(f.price)})</span>
    {isMaterials(f.name) ? <> <span className="muted">· counted as crafting materials</span></> : priceHint}</>;
}

// "Your kinah": the shared amount and the last change the log made to it.
function KinahField({ have, lastDelta }) {
  const ref = useRef(null);
  const [text, setText] = useState(have == null ? "" : full(have));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { if (document.activeElement !== ref.current) setText(have == null ? "" : full(have)); }, [have]);
  const commit = () => {
    const raw = text.trim();
    const v = raw ? parseKinah(raw) : null;
    if (raw && !(v >= 0)) return setInvalid(true);
    setInvalid(false);
    writeKinah(v);
    setText(v == null ? "" : full(v));
  };
  return (
    <div className="field kinah-field">
      <label htmlFor="kinah">Your kinah</label>
      <input id="kinah" ref={ref} type="text" inputMode="decimal" placeholder="e.g. 250m" autoComplete="off" value={text} aria-invalid={invalid || undefined}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
      <p className="muted kinah-note" id="kinahNote">
        {have == null ? "Set it to have every entry here update the Market Analysis plan."
          : lastDelta ? <>Last change: <strong className={signClass(lastDelta)}>{kinah(lastDelta, { sign: true })}</strong>. Used by the Market Analysis plan.</>
            : "Moves with every entry here; used by the Market Analysis plan."}
      </p>
    </div>
  );
}

function ListingRow({ l, left, now, onSold, onExpire, onRelist }) {
  const [qty, setQty] = useState(String(left));
  useEffect(() => setQty(String(left)), [left]);
  const gross = left * l.price;
  const net = gross - Math.round(gross * l.taxPct / 100);
  const tl = timeLeft(l, now);
  return (
    <tr className={tl.over ? "overdue" : undefined}>
      <td className="name"><span className="item-cell"><EntryIcon e={l} /><span>{l.name}</span></span></td>
      <td className="dim">{fmtDate(l.ts)}</td>
      <td className={tl.over ? "warn" : "dim"} title="Listings last 3 days">{tl.over ? "Expired " : "Expires "}{tl.text}</td>
      <td>{left.toLocaleString()}{left < l.qty && <> <span className="dim">of {l.qty.toLocaleString()}</span></>}</td>
      <td title={full(l.price)}>{kinah(l.price)}</td>
      <td className="pos" title={`${full(net)} after ${l.taxPct}% tax`}>{kinah(net)}</td>
      <td className="listing-actions">
        <label className="sr-only" htmlFor={`sold-${l.id}`}>Quantity sold</label>{" "}
        <input type="number" id={`sold-${l.id}`} className="sold-qty" min="1" max={left} step="1" value={qty} inputMode="numeric"
          onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSold(l.id, Number(qty)); }} />{" "}
        <button type="button" className="mini-btn good" onClick={() => onSold(l.id, Number(qty))}>Mark sold</button>{" "}
        <button type="button" className="mini-btn" title="It didn't sell: close the listing (the listing fee is lost)" onClick={() => onExpire(l.id)}>Expired</button>{" "}
        <button type="button" className="mini-btn" title="Close it as expired and post the unsold units again, paying a new listing fee" onClick={() => onRelist(l.id)}>Relist</button>
      </td>
    </tr>
  );
}

function Listings({ active, entries, now, onSold, onExpire, onRelist }) {
  let units = 0, value = 0;
  for (const l of active) {
    const left = remaining(entries, l), gross = left * l.price;
    units += left; value += gross - Math.round(gross * l.taxPct / 100);
  }
  return (
    <section className="panel table-panel" id="listingsPanel">
      <div className="table-head">
        <h2>Active listings</h2>
        <p className="muted" id="listingsNote">{units.toLocaleString()} unit{units === 1 ? "" : "s"} on the market, worth {kinah(value)} after tax if they all sell.</p>
      </div>
      <div className="table-scroll">
        <table className="ledger-table listings-table" id="listings">
          <thead><tr><th>Item</th><th>Listed</th><th>Status</th><th>Left</th><th>Price each</th><th>If sold</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {active.map((l) => <ListingRow key={l.id} l={l} left={remaining(entries, l)} now={now} onSold={onSold} onExpire={onExpire} onRelist={onRelist} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ByItem({ inView, entries }) {
  const groups = new Map();
  for (const e of inView) {
    const k = e.name.toLowerCase();
    if (!groups.has(k)) groups.set(k, { name: e.name, key: e.key, first: e, list: [] });
    groups.get(k).list.push(e);
  }
  const rows = [...groups.values()].map((g) => {
    const t = totals(g.list);
    const buys = g.list.filter((e) => e.side === "buy"), sells = g.list.filter((e) => e.side === "sell");
    const avg = (list) => (list.length ? list.reduce((s, e) => s + e.qty * e.price, 0) / list.reduce((s, e) => s + e.qty, 0) : null);
    // Units still listed are counted from every active listing, not just this period's.
    const listed = entries.filter((e) => isActive(entries, e) && e.name.toLowerCase() === g.name.toLowerCase()).reduce((n, e) => n + remaining(entries, e), 0);
    return { ...g, ...t, avgBuy: avg(buys), avgSell: avg(sells), listed, onHand: t.bought - t.sold - listed };
  }).sort((a, b) => b.profit - a.profit);
  return (
    <table className="ledger-table" id="byItem">
      <thead><tr><th>Item</th><th>Bought</th><th>Avg buy</th><th>Spent</th><th>Sold</th><th>Avg sell</th><th>Received</th><th>Profit</th><th>Listed</th><th>On hand</th></tr></thead>
      <tbody>
        {rows.length ? rows.map((r) => (
          <tr key={r.name.toLowerCase()}>
            <td className="name"><span className="item-cell"><EntryIcon e={r.first} size="" /><span className="item-text"><strong>{isMaterials(r.name) ? "Crafting materials" : r.name}</strong>{isMaterials(r.name) && <span className="meta">Bought to craft</span>}</span></span></td>
            <td>{r.bought ? r.bought.toLocaleString() : "—"}</td>
            <td>{kinah(r.avgBuy)}</td>
            <td>{r.spent ? kinah(r.spent) : "—"}</td>
            <td>{r.sold ? r.sold.toLocaleString() : "—"}</td>
            <td>{kinah(r.avgSell)}</td>
            <td>{r.received ? kinah(r.received) : "—"}</td>
            <td className={signClass(r.profit) || undefined} title={full(r.profit)}>{kinah(r.profit, { sign: true })}</td>
            <td>{r.listed ? r.listed.toLocaleString() : "—"}</td>
            <td title={r.onHand < 0 ? "More sold or listed than bought here (crafted or bought before you started logging)" : ""}>{r.onHand < 0 || !r.bought || isMaterials(r.name) ? "—" : r.onHand.toLocaleString()}</td>
          </tr>
        )) : <tr><td colSpan={10} className="empty-row">{entries.length ? "No transactions in this period." : "Nothing logged yet. Add your first purchase or sale above."}</td></tr>}
      </tbody>
    </table>
  );
}

const TX_COLS = [
  ["ts", "Date"], ["name", "Item"], ["side", "Type"], ["qty", "Qty"], ["price", "Price each"],
  ["gross", "Total"], ["deduct", "Tax + fee"], ["net", "Kinah ±"], ["note", "Note"],
];

function TypeCell({ e, entries }) {
  if (e.side === "buy") return <span className="pill neutral bought">Bought</span>;
  if (e.side === "sell") return <><span className="pill good sold">Sold</span>{e.listingId && <span className="type-sub">from listing</span>}</>;
  const sold = soldQty(entries, e), left = e.qty - sold;
  const sub = left <= 0 ? "all sold" : e.expired ? `expired · ${left} unsold` : sold ? `${left} of ${e.qty} left` : "on the market";
  return <><span className={cx("pill listed", !isActive(entries, e) && "closed")}>Listed</span><span className="type-sub">{sub}</span></>;
}
function deductTitle(e, a) {
  if (e.side === "buy") return "No tax on purchases";
  if (e.side === "list") return `Listing fee ${full(a.fee)} (${e.feePct}%), paid when listed`;
  return e.listingId ? `Tax ${full(a.tax)} (${e.taxPct}%); listing fee was paid on the listing` : `Tax ${full(a.tax)} (${e.taxPct}%) + listing fee ${full(a.fee)} (${e.feePct}%)`;
}

function Transactions({ inView, entries, sort, setSort, editing, onEdit, onDelete }) {
  const { key, dir } = sort;
  const val = (e) => (key === "gross" || key === "net" ? amounts(e)[key] : key === "deduct" ? amounts(e).tax + amounts(e).fee : e[key]);
  const rows = [...inView].sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === "string" ? x.localeCompare(y) : (x ?? 0) - (y ?? 0)) * dir || b.ts - a.ts;
  });
  const sortBy = (k) => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : k === "name" || k === "note" || k === "side" ? 1 : -1 }));
  return (
    <table className="ledger-table" id="txTable">
      <thead>
        <tr>
          {TX_COLS.map(([k, label]) => (
            <th key={k} aria-sort={k === key ? (dir > 0 ? "ascending" : "descending") : undefined}><button type="button" onClick={() => sortBy(k)}>{label}</button></th>
          ))}
          <th><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length ? rows.map((e) => {
          const a = amounts(e);
          return (
            <tr key={e.id} className={e.id === editing ? "editing" : undefined}>
              <td className="dim">{fmtDate(e.ts)}</td>
              <td className="name"><span className="item-cell"><EntryIcon e={e} /><span>{e.name}</span></span></td>
              <td><TypeCell e={e} entries={entries} /></td>
              <td>{e.qty.toLocaleString()}</td>
              <td title={full(e.price)}>{kinah(e.price)}</td>
              <td title={full(a.gross)}>{kinah(a.gross)}</td>
              <td title={deductTitle(e, a)}>{e.side === "buy" ? "—" : kinah(a.tax + a.fee)}</td>
              <td className={signClass(a.net) || undefined} title={full(a.net)}>{kinah(a.net, { sign: true })}</td>
              <td className="note-cell">{e.note || ""}</td>
              <td className="actions">
                <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${e.name}`} onClick={() => onEdit(e.id)}>✎</button>
                <button type="button" className="icon-btn danger" title="Delete" aria-label={`Delete ${e.name}`} onClick={() => onDelete(e.id)}>✕</button>
              </td>
            </tr>
          );
        }) : <tr><td colSpan={10} className="empty-row">{entries.length ? "No transactions in this period." : "No transactions yet."}</td></tr>}
      </tbody>
    </table>
  );
}
