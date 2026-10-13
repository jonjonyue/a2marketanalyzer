// Pure profitability math. No DOM here, so it can be unit-tested with node.

export const SALES_WINDOW_DAYS = 28; // official /api/items units_sold covers the last 28 days

export const DEFAULT_SETTINGS = {
  priceBasis: "conservative", // conservative | listing | sold
  costBasis: "cheapest",      // cheapest (site's cheapest-path cost) | market (buy every input)
  salesTaxPct: 10,            // exchange tax taken from the sale price, in percent
  listingFeePct: 2,           // fee charged on the listing price when you list, in percent
  sharePct: 25,               // share of daily sales you expect to capture
  minSalesPerDay: 0.5,        // below this the market is "thin"
  maxSupplyDays: 14,          // above this the market is "oversupplied"
};

// Listing-history sales estimator settings.
export const ESTIMATOR = {
  windowDays: 7,       // estimate over the last 7 days of snapshots
  expiryHours: 72,     // listings expire after 3 days on the exchange
  expiryTolMin: 90,    // a removal within ±90 min of a listing's 72h mark counts as an expiry
  minDays: 1,          // need at least a day of history to report a rate
  // Hourly snapshots miss listings that are posted and bought between two snapshots.
  // Checked against the game's own daily sales on an EU server (26 item-days, Oct 2026):
  // the raw count caught 122 of 179 sales, so raw counts are scaled up by ~1.5.
  captureAdjust: 1.5,
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Estimate sales for one item from its snapshot history.
 *
 * history: [[epochMinutes, listings, cheapestPrice], ...] sorted, only snapshots where the item was listed.
 * grid:    sorted epochMinutes of every market snapshot (an item missing from one had 0 listings).
 *
 * Between two snapshots:
 *  - listings that disappear are removals; removals that land ~72h after a listing appeared are expiries,
 *    the rest are counted as sales (cancellations are indistinguishable and get counted too);
 *  - if the count stays flat but the cheapest price rises, the cheapest listing sold and was replaced: one sale.
 * Each sale is priced at the cheapest listing just before it disappeared.
 */
export function estimateSales(history, grid, opts = ESTIMATOR) {
  const o = { ...ESTIMATOR, ...opts };
  if (!history?.length || !grid?.length) return null;
  const byT = new Map(history.map((p) => [p[0], p]));
  const first = history[0][0];
  const timeline = grid.filter((t) => t >= first).map((t) => {
    const p = byT.get(t);
    return p ? { t, n: p[1], low: p[2] } : { t, n: 0, low: null };
  });
  if (timeline.length < 2) return null;

  const end = timeline[timeline.length - 1].t;
  const start = Math.max(first, end - o.windowDays * 1440);
  const expiries = []; // predicted expiry times (epoch minutes) of listings we saw appear
  let sales = 0, cheapestSold = 0, priceSum = 0, priceN = 0;

  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1], b = timeline[i];
    const d = b.n - a.n;
    const cheapestGone = a.low != null && (b.low == null || b.low > a.low);
    let s = 0, sLow = 0;
    if (d > 0) {
      for (let k = 0; k < d; k++) expiries.push(b.t + o.expiryHours * 60);
    } else if (d < 0) {
      let expired = 0;
      for (let j = 0; j < expiries.length && expired < -d; j++) {
        if (Math.abs(expiries[j] - b.t) <= o.expiryTolMin) { expiries.splice(j, 1); j--; expired++; }
      }
      s = -d - expired;
      sLow = cheapestGone && s > 0 ? 1 : 0;
    } else if (cheapestGone && a.n > 0) {
      s = sLow = 1;
    }
    if (b.t > start && s > 0) {
      sales += s;
      cheapestSold += sLow;
      priceSum += a.low * s;
      priceN += s;
    }
  }

  const days = (end - start) / 1440;
  const enough = days >= o.minDays;
  const observedPerDay = enough ? sales / days : null;
  return {
    days,
    sales,
    cheapestSold,
    observedPerDay,
    perDay: observedPerDay == null ? null : observedPerDay * o.captureAdjust,
    lowerPerDay: enough ? cheapestSold / days : null,
    avgSalePrice: priceN ? priceSum / priceN : null,
  };
}

/** All snapshot times seen across a server's items: the market-wide snapshot schedule. */
export function snapshotGrid(histories) {
  const set = new Set();
  for (const h of Object.values(histories || {})) for (const p of h) set.add(p[0]);
  return [...set].sort((a, b) => a - b);
}

/** Pick the sell price for one craft according to the chosen basis. */
export function sellPrice(listing, soldAvg, basis) {
  if (basis === "listing") return listing;
  if (basis === "sold") return soldAvg;
  // conservative: the lower of what's listed now and what it actually sold for
  if (listing != null && soldAvg != null) return Math.min(listing, soldAvg);
  return listing ?? soldAvg;
}

/**
 * Join one craft target with its item stats and sales estimate, and compute every metric the dashboard shows.
 * target: a row from /api/crafts targets; item: the matching /api/items row; est: estimateSales() result.
 * Official game statistics win where they exist; otherwise the listing-history estimate is used.
 */
export function analyzeCraft(target, item, settings = DEFAULT_SETTINGS, est = null) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const listing = num(item?.price) ?? num(target.market_price);
  const listings = num(item?.listings) ?? num(target.listings) ?? 0;
  const sold28 = num(item?.units_sold);
  const officialAvg = num(item?.sold_avg_price);

  const salesSource = sold28 != null ? "official" : est?.perDay != null ? "estimate" : null;
  const perDay = sold28 != null ? sold28 / SALES_WINDOW_DAYS : est?.perDay ?? null;
  const soldAvg = officialAvg ?? num(est?.avgSalePrice);
  const priceSource = officialAvg != null ? "official" : soldAvg != null ? "estimate" : null;

  const cost = s.costBasis === "market" ? num(target.cost_market) ?? num(target.cost) : num(target.cost);
  const price = sellPrice(listing, soldAvg, s.priceBasis);
  // Both fees scale with the price you list at, so one listing that sells keeps price × (1 − tax − fee).
  const net = price == null ? null : price * (1 - (s.salesTaxPct + s.listingFeePct) / 100);
  const profit = net == null || cost == null ? null : net - cost;
  const marginPct = profit == null || !cost ? null : (profit / cost) * 100;

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
    salesSource, priceSource, est,
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
  const histories = market.history || {};
  const grid = snapshotGrid(histories);
  return (market.targets || [])
    .map((t) => {
      const h = histories[String(t.target_key)];
      const est = h ? estimateSales(h, grid) : null;
      return analyzeCraft(t, items.get(t.target_key), settings, est);
    })
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
