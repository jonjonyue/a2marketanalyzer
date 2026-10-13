// Pure profitability math. No DOM here, so it can be unit-tested with node.

export const SALES_WINDOW_DAYS = 28; // /api/items units_sold covers the last 28 days

export const DEFAULT_SETTINGS = {
  priceBasis: "conservative", // conservative | listing | sold
  costBasis: "cheapest",      // cheapest (site's cheapest-path cost) | market (buy every input)
  salesTaxPct: 10,            // exchange tax taken from the sale price, in percent
  listingFeePct: 2,           // fee charged on the listing price when you list, in percent
  sharePct: 25,               // share of daily sales you expect to capture
  minSalesPerDay: 0.5,        // below this the market is "thin"
  maxSupplyDays: 14,        // above this the market is "oversupplied"
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Pick the sell price for one craft according to the chosen basis. */
export function sellPrice(listing, soldAvg, basis) {
  if (basis === "listing") return listing;
  if (basis === "sold") return soldAvg;
  // conservative: the lower of what's listed now and what it actually sold for
  if (listing != null && soldAvg != null) return Math.min(listing, soldAvg);
  return listing ?? soldAvg;
}

/**
 * Join one craft target with its item stats and compute every metric the dashboard shows.
 * target: a row from /api/crafts targets; item: the matching row from /api/items (or undefined).
 */
export function analyzeCraft(target, item, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const listing = num(item?.price) ?? num(target.market_price);
  const listings = num(item?.listings) ?? num(target.listings) ?? 0;
  const soldAvg = num(item?.sold_avg_price);
  const sold28 = num(item?.units_sold);

  const cost = s.costBasis === "market" ? num(target.cost_market) ?? num(target.cost) : num(target.cost);
  const price = sellPrice(listing, soldAvg, s.priceBasis);
  // Both fees scale with the price you list at, so one listing that sells keeps price × (1 − tax − fee).
  const net = price == null ? null : price * (1 - (s.salesTaxPct + s.listingFeePct) / 100);
  const profit = net == null || cost == null ? null : net - cost;
  const marginPct = profit == null || !cost ? null : (profit / cost) * 100;

  const perDay = sold28 == null ? null : sold28 / SALES_WINDOW_DAYS;
  const supplyDays = perDay == null ? null : perDay > 0 ? listings / perDay : listings > 0 ? Infinity : 0;
  const dailyPool = profit == null || perDay == null ? null : profit * perDay;
  const yourDaily = dailyPool == null ? null : dailyPool * (s.sharePct / 100);

  return {
    key: target.target_key,
    name: target.name,
    shortName: String(target.name || "").replace(/^Artisan's Splendent /, ""),
    category: target.category,
    skill: target.skill,
    profile: target.profile_label,
    cost, listing, soldAvg, price, net, profit, marginPct,
    listings, sold28, perDay, supplyDays, dailyPool, yourDaily,
    missingInputs: num(target.missing) ?? 0,
    verdict: verdictFor({ profit, perDay, supplyDays, missing: num(target.missing) ?? 0 }, s),
  };
}

/** One label per craft so the table reads at a glance. */
export function verdictFor({ profit, perDay, supplyDays, missing }, s = DEFAULT_SETTINGS) {
  if (missing > 0) return { id: "incomplete", label: "Cost incomplete", tone: "warning" };
  if (profit == null) return { id: "nodata", label: "No price", tone: "neutral" };
  if (profit <= 0) return { id: "loss", label: "Loss", tone: "critical" };
  if (perDay == null) return { id: "nosales", label: "No sales data", tone: "neutral" };
  if (perDay < s.minSalesPerDay) return { id: "thin", label: "Slow seller", tone: "serious" };
  if (supplyDays > s.maxSupplyDays) return { id: "glut", label: "Oversupplied", tone: "serious" };
  return { id: "craft", label: "Craft it", tone: "good" };
}

/** Analyze a whole server's market and sort best-first by expected daily profit. */
export function analyzeMarket(market, settings = DEFAULT_SETTINGS) {
  const items = new Map((market.items || []).map((i) => [i.item_key, i]));
  return (market.targets || [])
    .map((t) => analyzeCraft(t, items.get(t.target_key), settings))
    .sort(byRank);
}

const VERDICT_ORDER = { craft: 0, glut: 1, thin: 2, nosales: 3, incomplete: 4, loss: 5, nodata: 6 };

export function byRank(a, b) {
  const pa = a.dailyPool ?? -Infinity;
  const pb = b.dailyPool ?? -Infinity;
  if (pa !== pb) return pb - pa;
  const va = VERDICT_ORDER[a.verdict.id];
  const vb = VERDICT_ORDER[b.verdict.id];
  if (va !== vb) return va - vb;
  return (b.profit ?? -Infinity) - (a.profit ?? -Infinity);
}
