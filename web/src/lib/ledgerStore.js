import { shortenName, parseKinah } from "./metrics.js";
import { KEYS, readJson, readRaw, writeRaw, writeKinah } from "./storage.js";

// Your listings logged in the Profit Calculator, in the shapes the plan (metrics.planBudget) needs.

function index(map, e, item) {
  for (const k of [e.key, shortenName(String(e.name || "")).toLowerCase()]) {
    if (k == null || k === "") continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
}

/** Every logged listing, by item key and by name: [{ t (epoch minutes), price }]. */
export function ownListings(entries = []) {
  const map = new Map();
  for (const e of entries) {
    if (e.side !== "list" || !(e.price > 0) || !Number.isFinite(e.ts)) continue;
    index(map, e, { t: Math.floor(e.ts / 60000), price: e.price });
  }
  return map;
}

/**
 * Active listings, by item key and by name: [{ units still unsold, t (epoch minutes), price }].
 * Listings older than 3 days are left out: they've expired in game even if not marked so in the calculator.
 */
export function ownActiveListings(entries = [], now = Date.now()) {
  const map = new Map();
  const sold = new Map();
  for (const e of entries) if (e.side === "sell" && e.listingId) sold.set(e.listingId, (sold.get(e.listingId) || 0) + (e.qty || 0));
  for (const e of entries) {
    if (e.side !== "list" || e.expired || !Number.isFinite(e.ts) || now - e.ts > 72 * 3600e3) continue;
    const units = (e.qty || 0) - (sold.get(e.id) || 0);
    if (units <= 0) continue;
    index(map, e, { units, t: Math.floor(e.ts / 60000), price: e.price });
  }
  return map;
}

/** How many units you have listed right now (active, under 3 days old): each takes one of the exchange's listing slots. */
export function activeListingCount(entries = [], now = Date.now()) {
  const sold = new Map();
  for (const e of entries) if (e.side === "sell" && e.listingId) sold.set(e.listingId, (sold.get(e.listingId) || 0) + (e.qty || 0));
  return entries.reduce((t, e) => (e.side !== "list" || e.expired || !Number.isFinite(e.ts) || now - e.ts > 72 * 3600e3 ? t
    : t + Math.max(0, (e.qty || 0) - (sold.get(e.id) || 0))), 0);
}

/** The ledger's entries straight from a stored string (no validation; the plan only reads them). */
export function entriesOf(raw) {
  try { return JSON.parse(raw || "null")?.entries || []; } catch { return []; }
}

// ---------- logging a listing from outside the Profit Calculator (the plan's "List" button) ----------

const LEDGER_DEFAULTS = { taxPct: 10, feePct: 2 };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const readLog = () => {
  const raw = readJson(KEYS.ledger);
  return raw && Array.isArray(raw.entries) ? { ...raw, settings: { ...LEDGER_DEFAULTS, ...raw.settings } } : { entries: [], settings: { ...LEDGER_DEFAULTS } };
};
// Your kinah moves by each logged change, as in the Profit Calculator.
function moveKinah(delta) {
  const have = parseKinah(readRaw(KEYS.budget));
  if (delta && Number.isFinite(have)) writeKinah(have + delta);
}

/** A listing entry for one unit at `price`, at the Profit Calculator's current tax and fee rates. */
export function listingEntry({ name, key, price }, settings = readLog().settings) {
  return { id: newId(), side: "list", name, key: key ?? null, qty: 1, price: Math.round(price),
    taxPct: settings.taxPct, feePct: settings.feePct, ts: Date.now(), note: "from plan" };
}
export const listingFee = (e) => Math.round(e.qty * e.price * e.feePct / 100);

/** Log a listing of one unit in the Profit Calculator and take its fee from your kinah. Returns the entry, or null if it couldn't be saved. */
export function listOne(item) {
  const log = readLog();
  const entry = listingEntry(item, log.settings);
  if (!writeRaw(KEYS.ledger, JSON.stringify({ ...log, entries: [...log.entries, entry] }))) return null;
  moveKinah(-listingFee(entry));
  return entry;
}
/** Undo listOne: remove the entry and give its fee back. */
export function unlistOne(entry) {
  const log = readLog();
  if (!log.entries.some((e) => e.id === entry.id)) return;
  if (writeRaw(KEYS.ledger, JSON.stringify({ ...log, entries: log.entries.filter((e) => e.id !== entry.id) }))) moveKinah(listingFee(entry));
}
