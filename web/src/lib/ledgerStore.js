import { shortenName } from "./metrics.js";

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

/** The ledger's entries straight from a stored string (no validation; the plan only reads them). */
export function entriesOf(raw) {
  try { return JSON.parse(raw || "null")?.entries || []; } catch { return []; }
}
