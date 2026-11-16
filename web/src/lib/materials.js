// "Materials: stock up?": each market material's cheapest price against its usual price over the last two weeks.
// The data (fetch_snapshot.py) is market.material_watch [{ item_key, name, uses }] and market.material_history
// { key: [[epochMinutes, cheapest], ...] } (hourly, MATERIAL_DAYS). Materials from NPCs, and ones you craft or
// convert yourself, aren't in it. The listings don't show quantities, so this never says how many to buy.

export const MATERIAL_RULES = {
  minPoints: 48,        // hours of prices needed before a material gets a signal
  stalePriceH: 6,       // no price this recent: nothing listed now
  recentH: 72,          // "lately": the last 3 days
  buyPct: 20, buyUnder: 0.10,      // Stock up: in its cheapest 20% of the window and at least 10% under usual
  cheapPct: 35, cheapUnder: 0.05,  // Cheap: cheapest 35% and at least 5% under usual
  priceyPct: 80, priceyOver: 0.10, // Pricey: priciest 20% and at least 10% over usual
  shift: 0.15,          // the last 3 days running this far from the two-week usual: the usual may be out of date
  falling: 0.08,        // the last day this far under the two days before: still falling
};

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};

/** The signal shown for each kind, best first. */
export const MATERIAL_SIGNALS = {
  buy: { label: "Stock up", order: 0 },
  cheap: { label: "Cheap", order: 1 },
  dropping: { label: "Dropping", order: 2 },
  pricey: { label: "Pricey", order: 3 },
  normal: { label: "Normal", order: 4 },
};

/** One material's stats and signal, or null without enough history. */
export function analyzeMaterial(m, points, now = Date.now(), rules = MATERIAL_RULES) {
  const pts = (points || []).filter((p) => p[1] > 0);
  if (pts.length < rules.minPoints) return null;
  const nowMin = now / 60000;
  const last = pts[pts.length - 1];
  const listed = nowMin - last[0] <= rules.stalePriceH * 60;
  const lows = pts.map((p) => p[1]);
  const price = last[1];
  const usual = median(lows);
  const pct = Math.round((100 * lows.filter((x) => x < price).length) / lows.length);
  const end = last[0];
  const recent = median(pts.filter((p) => p[0] > end - rules.recentH * 60).map((p) => p[1]));
  const lastDay = median(pts.filter((p) => p[0] > end - 24 * 60).map((p) => p[1]));
  const before = median(pts.filter((p) => p[0] <= end - 24 * 60 && p[0] > end - 72 * 60).map((p) => p[1]));
  const vs = price / usual - 1;           // against the two-week usual
  const vsRecent = recent ? price / recent - 1 : 0; // against the last 3 days
  const shift = recent ? recent / usual - 1 : 0;    // the last 3 days against the two-week usual
  const falling = lastDay != null && before != null && lastDay < before * (1 - rules.falling);

  let signal = "normal";
  if (!listed) signal = "normal";
  else if (pct <= rules.buyPct && vs <= -rules.buyUnder) signal = shift <= -rules.shift ? "dropping" : "buy";
  else if (pct <= rules.cheapPct && vs <= -rules.cheapUnder) signal = shift <= -rules.shift ? "dropping" : "cheap";
  else if (shift >= rules.shift && vsRecent <= -rules.buyUnder) signal = "cheap"; // a dip under a level that has risen lately
  else if (pct >= rules.priceyPct && vs >= rules.priceyOver) signal = "pricey";

  // Cheapest time of day: the median price against usual in each 3-hour window of the viewer's local day.
  const windows = Array.from({ length: 8 }, () => []);
  for (const [t, p] of pts) windows[Math.floor(new Date(t * 60000).getHours() / 3)].push(p / usual);
  const byWindow = windows.map((w) => (w.length >= 3 ? median(w) - 1 : null));
  let best = null;
  byWindow.forEach((v, i) => { if (v != null && (best == null || v < byWindow[best])) best = i; });

  // 6-hour medians for the trend line.
  const spark = [];
  for (let i = 0; i < pts.length; i += 6) spark.push(median(pts.slice(i, i + 6).map((p) => p[1])));

  const uses = m.uses || [];
  return {
    key: m.item_key, name: m.name, uses, base: uses.length > 0 && uses.every((u) => u.startsWith("→ ")),
    price, listed, usual, pct, lo: Math.min(...lows), hi: Math.max(...lows), recent, vs, vsRecent, shift, falling,
    signal, byWindow, bestWindow: best, spark, days: (end - pts[0][0]) / 1440,
  };
}

/** Every watched material of the market, best opportunities first. */
export function analyzeMaterials(market, now = Date.now()) {
  const hist = market?.material_history || {};
  return (market?.material_watch || [])
    .map((m) => analyzeMaterial(m, hist[m.item_key], now))
    .filter(Boolean)
    .sort((a, b) => MATERIAL_SIGNALS[a.signal].order - MATERIAL_SIGNALS[b.signal].order || a.vs - b.vs);
}

/** Local-time label of 3-hour window i (0 = midnight to 3am). */
export function windowLabel(i) {
  const h = (x) => (x % 12 === 0 ? 12 : x % 12) + (x < 12 || x === 24 ? "am" : "pm");
  const a = i * 3, b = i * 3 + 3;
  return `${h(a)}–${h(b)}`.replace(/am–(\d+)am/, "–$1am").replace(/pm–(\d+)pm/, "–$1pm");
}
