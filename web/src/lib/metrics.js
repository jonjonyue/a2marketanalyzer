// Pure profitability math. No DOM here, so it can be unit-tested with node.

export const SALES_WINDOW_DAYS = 28; // official /api/items units_sold covers the last 28 days

export const DEFAULT_SETTINGS = {
  priceBasis: "conservative", // conservative | listing | sold
  costBasis: "cheapest",      // cheapest (site's cheapest-path cost) | market (buy every input)
  salesTaxPct: 10,            // exchange tax taken from the sale price, in percent
  listingFeePct: 2,           // fee charged on the listing price when you list, in percent
  sharePct: 25,               // share of daily sales you expect to capture
  listingDays: 3,             // listings expire after 3 days
  planDays: 1.5,              // the kinah plan only makes what the market can take within this many days
  maxListings: 10,            // the exchange lets one character have this many listings up at once
  maxSupplyDays: 5,           // more days of supply than this (listings ÷ sold/day) is "Oversupplied"
                              // "Slow seller": a new listing would wait (listings + 1) ÷ sold/day > listingDays to sell
  minRoc: 15,                 // return on capital (%) below this is "Low return"
  topRoc: 50,                 // "Top pick" needs at least this return on capital (%) ...
  topSalesPerDay: 1,          // ... at least this many sold per day ...
  topSupplyDays: 3,           // ... and at most this many days of supply (sells within one listing period)
  capitalConfidence: 0.9,     // capital needed = enough attempts for this chance of making at least one
  // Crafting mastery per skill on the game's 1-100 scale (1-50 Novice, 51-100 Professional). 75 = Professional 25.
  proficiency: { Blacksmithing: 75, Armorsmithing: 75, Handicrafting: 75, Alchemy: 75 },
};

// Listing-history sales estimator settings.
export const ESTIMATOR = {
  windowDays: 7,       // estimate over the last 7 days of snapshots
  expiryHours: 72,     // listings expire after 3 days on the exchange
  expiryTolMin: 90,    // a removal within ±90 min of a listing's 72h mark counts as an expiry
  minDays: 1,          // need at least a day of history to report a rate
  // Hourly snapshots miss listings that are posted and bought between two snapshots.
  // Checked against the game's own daily sales on an EU server (26 item-days, Oct 2026):
  // the raw count caught about two-thirds of sales (168 of 265). The scale-up is set conservatively at 1.2
  // so estimates lean low rather than overstating demand.
  captureAdjust: 1.2,
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
  const events = []; // each inferred sale: [price (cheapest listing before it), listings up at the time, units]
  const undercuts = []; // each time a new listing went in below the cheapest: [snapshot time, previous snapshot time, new cheapest, depth]

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
    // An undercut: the cheapest price dropped while no listing disappeared (a new, cheaper listing went up).
    if (b.t > start && d >= 0 && a.low > 0 && b.low > 0 && b.low < a.low) undercuts.push([b.t, a.t, b.low, 1 - b.low / a.low]);
    if (b.t > start && s > 0) {
      sales += s;
      cheapestSold += sLow;
      priceSum += a.low * s;
      priceN += s;
      if (a.low > 0) events.push([a.low, a.n, s]);
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
    // rounded to a tenth, so everything downstream uses the number the table shows
    perDay: observedPerDay == null ? null : Math.round(observedPerDay * o.captureAdjust * 10) / 10,
    lowerPerDay: enough ? cheapestSold / days : null,
    avgSalePrice: priceN ? priceSum / priceN : null,
    events,
    undercuts,
    undercutDepths: undercuts.map((u) => u[3]),
    // Per day, as observed (no capture adjustment): undercuts vs sales of the cheapest listing. Their ratio says how
    // often a listing that's just become the cheapest sells before someone undercuts it.
    undercutsPerDay: enough ? undercuts.length / days : null,
    cheapestSoldPerDay: enough ? cheapestSold / days : null,
  };
}

/** All snapshot times seen across a server's items: the market-wide snapshot schedule. */
export function snapshotGrid(histories) {
  const set = new Set();
  for (const h of Object.values(histories || {})) for (const p of h) set.add(p[0]);
  return [...set].sort((a, b) => a - b);
}

/** Attempts needed for `confidence` odds of at least one hit when each attempt hits with chance p. */
export function attemptsFor(p, confidence = 0.9) {
  if (!(p > 0)) return null;
  if (p >= 1) return 1;
  return Math.max(1, Math.ceil(Math.log(1 - confidence) / Math.log(1 - p)));
}

/** Attempts needed for `confidence` odds of at least `n` hits at hit chance p (binomial tail). */
export function attemptsForN(p, n = 1, confidence = 0.9) {
  if (!(p > 0) || !(n >= 1)) return null;
  if (p >= 1) return n;
  for (let k = n; k < 5000; k++) {
    // P(at least n hits in k attempts) = 1 − P(fewer than n hits)
    let term = Math.pow(1 - p, k), below = 0; // P(0 hits)
    for (let j = 0; j < n; j++) {
      below += term;
      term = term * (k - j) / (j + 1) * p / (1 - p);
    }
    if (1 - below >= confidence) return k;
  }
  return null;
}

/** Capital to have ready: cost per attempt × attempts for `confidence` odds of making one. */
export function capitalNeeded(attemptCost, p, confidence = 0.9) {
  const n = attemptsFor(p, confidence);
  return attemptCost == null || n == null ? null : attemptCost * n;
}

/**
 * Hit chance of the last craft step for an item in aion2.exchange's cost chain (Artisan's or Expert's
 * Splendent): success × combo. The item's cost = per-attempt cost ÷ hit.
 */
export function chainOdds(chains, key) {
  for (const c of Object.values(chains || {})) {
    const step = (c.steps || []).find((s) => s.result_key === key);
    if (!step) continue;
    const hit = (step.success_rate ?? 1) * (step.combo_probability ?? 1);
    return hit > 0 ? { hitChance: hit } : {};
  }
  return {};
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

  const cost = target.costDetail ? num(target.cost)
    : s.costBasis === "market" ? num(target.cost_market) ?? num(target.cost) : num(target.cost);
  const price = sellPrice(listing, soldAvg, s.priceBasis);
  // Both fees scale with the price you list at, so one listing that sells keeps price × (1 − tax − fee).
  const net = price == null ? null : price * (1 - (s.salesTaxPct + s.listingFeePct) / 100);
  const profit = net == null || cost == null ? null : net - cost;
  const marginPct = profit == null || !cost ? null : (profit / cost) * 100;

  const supplyDays = perDay == null ? null : perDay > 0 ? listings / perDay : listings > 0 ? Infinity : 0;
  // How long a listing you post now would wait: behind every current listing, at the current sales rate.
  const daysToSell = perDay == null ? null : perDay > 0 ? (listings + 1) / perDay : Infinity;
  const dailyPool = profit == null || perDay == null ? null : profit * perDay;
  const turnover = net == null || perDay == null ? null : net * perDay; // market size after fees, cost aside
  const yourDaily = dailyPool == null ? null : dailyPool * (s.sharePct / 100);
  // Barrier to entry: the kinah to have ready to make one with s.capitalConfidence odds (combo luck included),
  // and the profit it returns on that capital.
  // Per-attempt cost: the recipe's own (True Dragon), or the row's cost × hit chance (cost = per-attempt ÷ hit),
  // so capital always agrees with the cost column, whatever cost basis is selected.
  const attemptCost = num(target.attemptCost) ?? (cost != null && target.hitChance ? cost * target.hitChance : null);
  // Never below the average cost: at high hit chances one attempt clears the confidence bar but costs less than average.
  const needed = capitalNeeded(attemptCost, target.hitChance, s.capitalConfidence);
  const entry = needed != null && cost != null ? Math.max(needed, cost) : needed ?? cost;
  const roc = profit == null || !entry ? null : (profit / entry) * 100;

  return {
    key: target.target_key,
    name: target.name,
    shortName: String(target.name || ""),
    tier: target.tier || "Artisan's Splendent",
    category: target.category,
    skill: target.skill,
    profile: target.profile_label,
    cost, listing, soldAvg, price, net, profit, marginPct,
    listings, sold28, perDay, supplyDays, daysToSell, dailyPool, yourDaily, turnover,
    capital: entry, roc, attemptCost, attempts90: attemptsFor(target.hitChance, s.capitalConfidence), hitChance: target.hitChance ?? null,
    success: target.success ?? null, recipeLevel: target.recipeLevel ?? null, playerLevel: target.playerLevel ?? null, locked: !!target.locked,
    salesSource, priceSource, est, costDetail: target.costDetail || null, transfer: target.transfer || null,
    missingInputs: num(target.missing) ?? 0,
    verdict: target.locked
      ? { id: "locked", label: `Needs ${masteryLabel(target.recipeLevel)}`, tone: "neutral" }
      : verdictFor({ profit, perDay, supplyDays, daysToSell, roc, missing: num(target.missing) ?? 0, noCost: cost == null }, s),
  };
}

/** One label per craft so the table reads at a glance. */
// Six verdicts, checked in this order: Loss, Slow seller, Oversupplied, Low return, Top pick, Craft it.
// Items that can't be judged yet get a status instead (cost incomplete / TBD, no price, no sales data, needs level).
export function verdictFor({ profit, perDay, supplyDays, daysToSell, roc, missing, noCost }, s = DEFAULT_SETTINGS) {
  if (missing > 0) return { id: "incomplete", label: "Cost incomplete", tone: "warning" };
  if (noCost) return { id: "nocost", label: "Cost TBD", tone: "neutral" };
  if (profit == null) return { id: "nodata", label: "No price", tone: "neutral" };
  if (profit <= 0) return { id: "loss", label: "Loss", tone: "critical" };
  if (perDay == null) return { id: "nosales", label: "No sales data", tone: "neutral" };
  if (supplyDays > s.maxSupplyDays) return { id: "glut", label: "Oversupplied", tone: "serious" };
  if (daysToSell == null || daysToSell > s.listingDays) return { id: "thin", label: "Slow seller", tone: "serious" };
  if (roc != null && roc < s.minRoc) return { id: "lowroc", label: "Low return", tone: "warning" };
  if (roc != null && roc >= s.topRoc && perDay >= s.topSalesPerDay && supplyDays <= s.topSupplyDays)
    return { id: "top", label: "Top pick", tone: "best" };
  return { id: "craft", label: "Craft it", tone: "good" };
}

/** Verdicts that mean "worth crafting". */
export const isWorthCrafting = (v) => v.id === "top" || v.id === "craft";

/** Analyze a whole server's market and sort best-first by expected daily profit. */
// ---------- crafting proficiency ----------
// Success rate by proficiency advantage ΔL = your mastery − recipe level (approximate community formula):
//   ΔL < 0: can't craft yet · ΔL = 0: base rate · 0 < ΔL ≤ 45: base + (cap − base) × ln(ΔL + 1) / ln(46) · ΔL > 45: cap.
// Caps for the Splendent steps come from aion2.exchange's model (its rates at mastery 100, which is past the cap).
export const PROFICIENCY = {
  baseRate: 0.74,          // success at ΔL = 0
  fullDelta: 45,           // ΔL where the cap is reached
  trueDragonCap: 0.9684,   // not in the site's model; assumed equal to the highest known cap (Artisan's step)
};
export const SKILLS = ["Blacksmithing", "Armorsmithing", "Handicrafting", "Alchemy"];
// aion2.exchange (and questlog) name two skills differently from the game; the dashboard uses the game's names.
export const SKILL_NAMES = { Tailoring: "Armorsmithing", Jewelcrafting: "Handicrafting" };
export const skillName = (s) => SKILL_NAMES[s] ?? s;

/** Mastery level (1-100) → "Novice 30" / "Professional 25". */
export function masteryLabel(level) {
  if (level == null) return "—";
  return level > 50 ? `Professional ${level - 50}` : `Novice ${level}`;
}

/** Success chance at `playerLevel` for a recipe of `recipeLevel` whose rate tops out at `cap`. 0 = can't craft yet. */
export function successAt(playerLevel, recipeLevel, cap, base = PROFICIENCY.baseRate) {
  if (cap == null) return null;
  if (playerLevel == null || recipeLevel == null) return cap;
  const d = playerLevel - recipeLevel;
  if (d < 0) return 0;
  if (d >= PROFICIENCY.fullDelta) return cap;
  if (d === 0) return Math.min(base, cap);
  return base + (cap - base) * Math.log(d + 1) / Math.log(PROFICIENCY.fullDelta + 1);
}

/**
 * aion2.exchange's cost chain for one Artisan's Splendent item, recomputed at a player's mastery: each step's success
 * from successAt() (the site's rate is the cap), then the expected cost of crafting every tier. Each attempt of step k
 * consumes one item of the tier before it, and only success × combo results count, so a tier costs
 * (that input + the step's materials) ÷ (success × combo).
 * The input gear is bought or crafted, whichever is cheaper (its cheapest listing vs. its own crafting cost); under
 * "buy everything" it's bought whenever it's listed. Buying it also works when you can't craft that tier yourself.
 * Returns a copy whose steps carry success_rate (yours), cap, level and how their input gear is sourced
 * (gear_method "buy" | "craft", gear_cost, and gear_method_market / gear_cost_market for "buy everything"), and whose
 * tiers carry cost (cheapest path) and cost_market (every input bought where listed); null when it can't be made.
 */
export function adjustChain(chain, playerLevel) {
  const steps = (chain.steps || []).map((s) => ({
    ...s, cap: s.success_rate, player_level: playerLevel,
    success_rate: successAt(playerLevel, s.mastery_level, s.success_rate),
  }));
  const tierOf = new Map((chain.tiers || []).map((x) => [x.item_key, x]));
  const per = (s, key) => (s.materials || []).reduce((a, m) => a + (num(m[key] ?? m.unit_price) ?? 0) * m.per_attempt, 0);
  const cost = new Map(), costMarket = new Map(); // tier item key -> cost to craft it
  steps.forEach((s, k) => {
    const q = s.success_rate * (s.combo_probability ?? 1);
    let gear = 0, gearMarket = 0;
    if (k > 0) {
      const prevKey = steps[k - 1].result_key;
      const listed = num(tierOf.get(prevKey)?.market_price);
      const buy = listed > 0 ? listed : null;
      const craft = cost.get(prevKey) ?? null;
      gear = buy != null && (craft == null || buy < craft) ? buy : craft;
      s.gear_method = gear == null ? null : gear === buy ? "buy" : "craft";
      s.gear_cost = gear;
      gearMarket = buy ?? costMarket.get(prevKey) ?? null;
      s.gear_method_market = gearMarket == null ? null : buy != null ? "buy" : "craft";
      s.gear_cost_market = gearMarket;
    }
    const ok = q > 0;
    cost.set(s.result_key, ok && gear != null ? (gear + per(s, "unit_price")) / q : null);
    costMarket.set(s.result_key, ok && gearMarket != null ? (gearMarket + per(s, "listing_price")) / q : null);
  });
  const tiers = (chain.tiers || []).map((x) => (cost.has(x.item_key) ? { ...x, cost: cost.get(x.item_key), cost_market: costMarket.get(x.item_key) } : { ...x }));
  return { ...chain, steps, tiers, player_level: playerLevel };
}

/**
 * Crafting cost from a recipe file (recipes/true_dragon.json).
 *
 * One craft attempt = 1 Artisan's Splendent item of the same slot + materials (+ gold fee).
 * The Artisan's Splendent input costs the cheaper of buying it and crafting it (the site's model),
 * or its listing under "buy everything". Materials are priced at their cheapest listing.
 * Every attempt yields a True Dragon item, so its cost is one attempt; the Splendent version only
 * comes from the combo roll (25%), so it costs one attempt ÷ 0.25 = 4×, with the plain True Dragon
 * results from the other attempts not credited (same convention as the site's own model).
 */
export function trueDragonCost(recipe, product_key, ctx, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  // The base input is either a tracked item (Artisan's Splendent, for True Dragon) or an
  // untracked one listed in market.inputs with its own craft_cost and price.
  const baseTarget = ctx.targets.get(recipe.base_key);
  const baseInput = ctx.inputs?.get(recipe.base_key);
  const baseListing = num(ctx.items.get(recipe.base_key)?.price) ?? num(baseTarget?.market_price) ?? num(baseInput?.price);
  const baseCraft = num(s.costBasis === "market" ? baseTarget?.cost_market ?? baseTarget?.cost : baseTarget?.cost) ?? num(baseInput?.craft_cost);
  let base, baseMethod;
  if (s.costBasis === "market") { base = baseListing ?? baseCraft; baseMethod = baseListing != null ? "buy" : "craft"; }
  else if (baseCraft != null && (baseListing == null || baseCraft <= baseListing)) { base = baseCraft; baseMethod = "craft"; }
  else { base = baseListing; baseMethod = "buy"; }

  let matsCost = 0, missing = base == null ? 1 : 0;
  const mats = recipe.materials.map((m) => {
    const mat = ctx.materials.get(m.key);
    const price = num(mat?.price);
    if (price == null) missing++;
    else matsCost += price * m.qty;
    return { key: m.key, name: mat?.name ?? String(m.key), qty: m.qty, price };
  });
  const attempt = (base ?? 0) + matsCost + (num(recipe.gold_cost) ?? 0);
  const isCombo = product_key === recipe.combo_key;
  const level = s.proficiency?.[ctx.skill] ?? null;
  const success = successAt(level, recipe.mastery_level, PROFICIENCY.trueDragonCap) ?? 1;
  const hit = success * (isCombo ? recipe.combo_probability : 1);
  const factor = hit > 0 ? 1 / hit : null;
  return {
    cost: missing || !factor ? null : attempt * factor,
    missing,
    hit, success, locked: success === 0, recipeLevel: recipe.mastery_level, playerLevel: level,
    detail: {
      baseKey: recipe.base_key, baseName: baseTarget?.name ?? baseInput?.name ?? String(recipe.base_key), base, baseMethod,
      baseCraft, baseListing, materials: mats, matsCost, attempt, factor, comboProbability: recipe.combo_probability,
      success, isCombo, recipeLevel: recipe.mastery_level, playerLevel: level,
    },
  };
}

export const recipeCost = trueDragonCost;

/**
 * Transfer route to a Splendent True Dragon item (reference only): one True Dragon item of the slot + the transfer
 * recipe's materials makes a Splendent True Dragon item that is bound to the character, so it can't be sold.
 * It's what a player can pay instead of buying one, which caps what buyers will pay on the market.
 * The True Dragon input costs the cheaper of crafting it (one True Dragon attempt) and buying it.
 * The transfer recipe's level isn't published; it's assumed to match the True Dragon recipe's.
 */
export function transferCost(recipe, ctx, settings = DEFAULT_SETTINGS) {
  const tr = recipe.transfer;
  if (!tr) return null;
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const tdKey = recipe.product_key;
  const tdTarget = ctx.targets.get(tdKey);
  const tdListing = num(ctx.items.get(tdKey)?.price) ?? num(tdTarget?.market_price);
  const tdCraft = trueDragonCost(recipe, tdKey, ctx, s).cost;
  let td, tdMethod;
  if (s.costBasis === "market") { td = tdListing ?? tdCraft; tdMethod = tdListing != null ? "buy" : "craft"; }
  else if (tdCraft != null && (tdListing == null || tdCraft <= tdListing)) { td = tdCraft; tdMethod = "craft"; }
  else { td = tdListing; tdMethod = "buy"; }
  let matsCost = 0, missing = td == null ? 1 : 0;
  const materials = tr.materials.map((m) => {
    const mat = ctx.materials.get(m.key);
    const price = num(mat?.price);
    if (price == null) missing++; else matsCost += price * m.qty;
    return { key: m.key, name: mat?.name ?? String(m.key), qty: m.qty, price };
  });
  const attempt = (td ?? 0) + matsCost + (num(tr.gold_cost) ?? 0);
  const level = s.proficiency?.[ctx.skill] ?? null;
  const success = successAt(level, recipe.mastery_level, PROFICIENCY.trueDragonCap) ?? 1;
  return {
    cost: missing || !(success > 0) ? null : attempt / success,
    missing, success, recipeId: tr.recipe_id, boundKey: tr.bound_key,
    tdKey, tdName: tdTarget?.name ?? String(tdKey), td, tdMethod, tdCraft, tdListing, materials, matsCost, attempt,
    recipeLevel: recipe.mastery_level, playerLevel: level,
  };
}

export function analyzeMarket(market, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings, proficiency: { ...DEFAULT_SETTINGS.proficiency, ...(settings.proficiency || {}) } };
  const items = new Map((market.items || []).map((i) => [i.item_key, i]));
  const histories = market.history || {};
  const grid = snapshotGrid(histories);
  market = { ...market, targets: (market.targets || []).map((t) => ({ ...t, skill: skillName(t.skill) })) };

  // Splendent chains at the player's mastery for that skill (one chain per Artisan's Splendent item).
  const chains = {};
  const stepOf = new Map(); // item key -> { chain, index }
  for (const t of market.targets || []) {
    const c = market.chains?.[String(t.target_key)];
    if (!c?.steps?.length) continue;
    const adj = adjustChain(c, s.proficiency[t.skill] ?? null);
    chains[String(t.target_key)] = adj;
    adj.steps.forEach((st, i) => stepOf.set(st.result_key, { chain: adj, index: i }));
  }
  const withChainCost = (t) => {
    const at = stepOf.get(t.target_key);
    if (!at) return t;
    const st = at.chain.steps[at.index];
    const tier = (at.chain.tiers || []).find((x) => x.item_key === t.target_key) || {};
    const locked = st.success_rate === 0;
    return {
      ...t, cost: tier.cost ?? null, cost_market: tier.cost_market ?? null,
      hitChance: locked ? null : st.success_rate * (st.combo_probability ?? 1),
      success: st.success_rate, locked, recipeLevel: st.mastery_level, playerLevel: st.player_level,
    };
  };
  const targets = (market.targets || []).map(withChainCost);

  const ctx = {
    items,
    targets: new Map(targets.map((t) => [t.target_key, t])),
    materials: new Map((market.materials || []).map((m) => [m.item_key, m])),
    inputs: new Map((market.inputs || []).map((m) => [m.item_key, m])),
  };
  const recipeFor = new Map();
  // A recipe costs its product (one attempt) and its combo result (÷ combo chance). Only items without a cost of
  // their own use it, so anything the site's model already costs keeps that cost.
  for (const r of market.recipes || []) {
    recipeFor.set(r.product_key, r);
    if (!recipeFor.has(r.combo_key)) recipeFor.set(r.combo_key, r);
  }
  const rows = targets
    .map((t0) => {
      let t = t0;
      const recipe = !stepOf.has(t.target_key) && t.cost == null ? recipeFor.get(t.target_key) : null;
      if (recipe) {
        const c = trueDragonCost(recipe, t.target_key, { ...ctx, skill: t.skill }, s);
        t = { ...t, cost: c.cost, cost_market: c.cost, missing: c.missing, costDetail: c.detail,
              transfer: t.target_key === recipe.combo_key ? transferCost(recipe, { ...ctx, skill: t.skill }, s) : null,
              attemptCost: c.detail.attempt, hitChance: c.hit > 0 ? c.hit : null,
              success: c.success, locked: c.locked, recipeLevel: c.recipeLevel, playerLevel: c.playerLevel };
      }
      const h = histories[String(t.target_key)];
      const est = h ? estimateSales(h, grid) : null;
      return analyzeCraft(t, items.get(t.target_key), s, est);
    })
    .sort(byRank);
  rows.chains = chains; // the chains at your mastery, for the recipe panels
  return rows;
}

export const VERDICT_ORDER = { top: 0, craft: 1, lowroc: 2, glut: 3, thin: 4, nosales: 5, nocost: 6, incomplete: 7, loss: 8, locked: 9, nodata: 10 };

export function byRank(a, b) {
  const pa = a.dailyPool ?? -Infinity;
  const pb = b.dailyPool ?? -Infinity;
  if (pa !== pb) return pb - pa;
  const va = VERDICT_ORDER[a.verdict.id];
  const vb = VERDICT_ORDER[b.verdict.id];
  if (va !== vb) return va - vb;
  const pr = (b.profit ?? -Infinity) - (a.profit ?? -Infinity);
  if (pr) return pr;
  return (b.turnover ?? -Infinity) - (a.turnover ?? -Infinity);
}

// Shorter display names: "Artisan's Splendent Bow" -> "Art Spl Bow", "Expert's Splendent Bow" -> "Exp Spl Bow".
export function shortenName(name) {
  return typeof name === "string"
    ? name.replace(/Artisan['’]s Splendent/g, "Art Spl").replace(/Expert['’]s Splendent/g, "Exp Spl")
    : name;
}

// Shorten every item name in a market object in place (targets, items, materials, recipe chains). Tier labels are left alone.
export function shortenMarketNames(market) {
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const k of Object.keys(v)) {
        if ((k === "name" || k === "result_name" || k === "material_name") && typeof v[k] === "string") v[k] = shortenName(v[k]);
        else if (typeof v[k] === "object") walk(v[k]);
      }
    }
  };
  if (market) for (const k of ["targets", "items", "materials", "chains", "recipes"]) walk(market[k]);
  return market;
}

/**
 * Where to put a kinah budget. Candidates are crafts worth making (Top pick / Craft it); the plan is the mix
 * that earns the most expected profit within your kinah and free listing slots. Each can get up to what the market has room for within `planDays` (`marketRoom`), where n units need cost-per-attempt × the attempts for 90% odds of n
 * successes (never less than n × the average cost). The units planned plus your active listings never exceed the
 * exchange's `maxListings` (10) per character. Returns the picks, totals, listing slots, and the best craft just out of reach.
 */
/**
 * How many of one item to make without flooding it or competing with yourself, looking `planDays` (1.5) ahead
 * so the plan stays flexible as the market moves. Your first unit, priced at the cheapest, sells once the market
 * clears what's already listed (the verdicts already require that within 3 days). Every extra unit sits behind your
 * own first one while other sellers keep relisting, so you only win your share of the sales left after current listings:
 *   n = 1 + floor(share × (sold/day × 1.5 − listings − 1)), at least 1.
 */
export function marketRoom(r, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!(r.perDay > 0)) return 1;
  const spare = r.perDay * s.planDays - (r.listings ?? 0) - 1; // sales left once current listings and your first sell
  return 1 + Math.max(0, Math.floor((s.sharePct / 100) * spare + 1e-9));
}

/** Days until your n-th unit sells: the current listings and your first at the market's pace, then your share of sales. */
export function daysForUnits(r, n, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!(r.perDay > 0)) return null;
  const first = ((r.listings ?? 0) + 1) / r.perDay;
  return first + (n - 1) / (r.perDay * (s.sharePct / 100));
}

/** A price just under `price`, landing on a 999-style figure (27,999,999 -> 27,799,999; 1,333 -> 1,319). */
export function undercutPrice(price) {
  if (!(price > 1)) return price;
  const target = price * 0.995;
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(target)) - 2)); // keep 3 significant digits
  return Math.max(1, Math.floor(target / mag) * mag - 1);
}

/** The plan's list price: see `suggestListing`. */
export function suggestedListPrice(r, settings = DEFAULT_SETTINGS) {
  const keep = 1 - (settings.salesTaxPct + settings.listingFeePct) / 100;
  // Your own logged listings of this item (from the Profit Calculator), so your relists don't count as competitors.
  const own = settings.ownListings?.get(r.key) || settings.ownListings?.get(String(r.name || "").toLowerCase()) || [];
  const a = suggestListing(r, { breakEven: r.cost > 0 && keep > 0 ? r.cost / keep : 0, ownListings: own });
  return a.price != null ? a : { ...a, price: r.price ?? null, basis: "price", note: "No listings or recent sales to price from; using the dashboard's sell price." };
}

export function planBudget(rows, budget, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!(budget > 0)) return null;
  const capitalFor = (r, n) => {
    if (!n) return 0;
    const k = r.attemptCost != null && r.hitChance ? attemptsForN(r.hitChance, n, s.capitalConfidence) : null;
    const lucky = k != null ? r.attemptCost * k : null;
    return Math.max(lucky ?? 0, n * r.cost);
  };
  const keep = 1 - (s.salesTaxPct + s.listingFeePct) / 100;
  const candidates = rows
    .filter((r) => isWorthCrafting(r.verdict) && r.cost > 0 && r.profit > 0 && r.perDay > 0)
    .sort((a, b) => (b.roc ?? 0) - (a.roc ?? 0));
  // Listing slots: the exchange allows maxListings at once, and your active listings (all items) already use some.
  // Gear doesn't stack, so every unit is its own listing.
  const slotsTotal = s.maxListings ?? Infinity;
  const free = Math.max(0, slotsTotal - (s.ownActiveCount ?? 0));

  const covered = []; // crafts your own active listings already fill
  const options = []; // crafts you could make more of: { r0, r, slots (market room left), myUnits, list, each }
  for (const r0 of candidates) {
    // Your own active listings of this item (from the Profit Calculator). Those posted before the market snapshot are
    // already in its listing count; take them out so they aren't counted twice (once as yours, once as competitors).
    const mine = s.ownActive?.get(r0.key) || s.ownActive?.get(String(r0.name || "").toLowerCase()) || [];
    const myUnits = mine.reduce((t, l) => t + l.units, 0);
    const inSnapshot = s.snapshotAt ? mine.filter((l) => l.t <= s.snapshotAt).reduce((t, l) => t + l.units, 0) : 0;
    const r = myUnits ? { ...r0, listings: Math.max(0, (r0.listings ?? 0) - inSnapshot) } : r0;
    const room = marketRoom(r, s);
    const slots = Math.max(0, room - myUnits); // what's left after your listings take their places
    if (myUnits && !slots) { covered.push({ row: r0, myUnits, room }); continue; }
    const list = suggestedListPrice(r, s);
    const each = list.price != null ? list.price * keep - r.cost : r.profit; // profit per unit at the suggested price
    if (each > 0) options.push({ r0, r, slots, myUnits, list, each });
  }

  // Choose how many of each to make: the most expected profit that fits both your kinah (capital set aside) and
  // your free listing slots. Exact, over Pareto fronts of (capital, profit) per number of slots used; with at most
  // 10 slots this stays small. So when slots are short, two cheaper listings can lose to one that earns more.
  const cap = Math.min(free, options.reduce((t, o) => t + o.slots, 0));
  let fronts = Array.from({ length: cap + 1 }, (_, k) => (k ? [] : [{ capital: 0, profit: 0, units: [] }]));
  const prune = (list) => {
    list.sort((a, b) => a.capital - b.capital || b.profit - a.profit);
    const out = [];
    for (const x of list) if (!out.length || x.profit > out[out.length - 1].profit + 1e-6) out.push(x);
    return out.length > 400 ? out.filter((_, i) => i % Math.ceil(out.length / 400) === 0 || i === out.length - 1) : out;
  };
  options.forEach((o, idx) => {
    const next = fronts.map((f) => [...f]);
    for (let k = 0; k < fronts.length; k++) {
      for (const st of fronts[k]) {
        for (let n = 1; n <= o.slots && k + n <= cap; n++) {
          const capital = st.capital + capitalFor(o.r, n);
          if (capital > budget) break;
          next[k + n].push({ capital, profit: st.profit + n * o.each, units: [...st.units, [idx, n]] });
        }
      }
    }
    fronts = next.map(prune);
  });
  let best = fronts[0][0];
  for (const f of fronts) for (const x of f) if (x.profit > best.profit + 1e-6 || (Math.abs(x.profit - best.profit) <= 1e-6 && x.capital < best.capital)) best = x;
  const chosen = new Map(best.units);

  const picks = [];
  options.forEach((o, idx) => {
    const n = chosen.get(idx);
    if (!n) return;
    picks.push({ row: o.r0, units: n, slots: o.slots, myUnits: o.myUnits, capital: capitalFor(o.r, n), spend: n * o.r.cost, profit: n * o.each,
      listAt: o.list.price, listBasis: o.list.basis, listNote: o.list.note,
      netEach: o.list.price != null ? o.list.price * keep : null, daysToSell: daysForUnits(o.r, o.myUnits + n, s) });
  });
  picks.sort((a, b) => (b.row.roc ?? 0) - (a.row.roc ?? 0));
  const capital = picks.reduce((t, p) => t + p.capital, 0);
  const profit = picks.reduce((t, p) => t + p.profit, 0);
  const spend = picks.reduce((t, p) => t + p.spend, 0);
  const left = budget - capital;
  const planned = picks.reduce((t, p) => t + p.units, 0);
  const slotsLeft = free - planned;
  // What's held back: a craft that could take another unit. If one more would fit your kinah, the slots are what
  // stopped it; otherwise kinah did, and the best of those is "next up".
  const more = options.map((o, idx) => ({ o, n: chosen.get(idx) || 0 })).filter(({ o, n }) => n < o.slots);
  const capped = more.some(({ o, n }) => slotsLeft <= 0 && capitalFor(o.r, n + 1) - capitalFor(o.r, n) <= left);
  const short = more.filter(({ n }) => !n).map(({ o }) => ({ row: o.r0, capital: capitalFor(o.r, 1), myUnits: o.myUnits }))
    .filter((x) => x.capital > left).sort((a, b) => (b.row.roc ?? 0) - (a.row.roc ?? 0));
  const nextUp = slotsLeft > 0 ? short[0] || null : null;
  return { budget, picks, capital, spend, profit, left, roi: capital ? (profit / capital) * 100 : null,
    nextUp: nextUp && { ...nextUp, short: nextUp.capital - left }, candidates: candidates.length, covered,
    slots: { total: slotsTotal, yours: s.ownActiveCount ?? 0, planned, capped } };
}

// "1.5m" -> 1500000, "250k" -> 250000, "1,234,567" -> 1234567. Returns NaN if it can't be read.
export function parseKinah(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[,\s_]/g, "");
  const m = t.match(/^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/);
  if (!m) return NaN;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function weightedMedian(events) {
  const xs = events.flatMap(([price, , units]) => Array(Math.max(1, Math.min(units, 20))).fill(price)).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
}

export const LISTING_ADVICE = {
  thinListings: 2, minThinSales: 2, maxPremium: 1.5,
  minUndercuts: 2,      // undercuts seen in the window before judging the risk
  safeOdds: 0.6,        // below this chance of selling before an undercut, price deeper for a surer sale
  depthPercentile: 0.75, maxDepth: 0.15, minDepth: 0.02,
};

// Chance the cheapest listing sells before someone undercuts it, and how deep undercutters usually go.
export function undercutRisk(est, o = LISTING_ADVICE, own = []) {
  // Undercuts that match one of your own logged listings (same item, appeared within the hour around when you logged
  // it, price within 1%) are you, not a competitor: leave them out.
  const all = est?.undercuts || [];
  const isOwn = ([t, prevT, low]) => own.some((l) => l.t >= prevT - 60 && l.t <= t + 60 && Math.abs(l.price - low) <= low * 0.01);
  const theirs = all.filter((u) => !isOwn(u));
  const depths = theirs.map((u) => u[3]);
  const days = est?.days;
  const U = days > 0 && est?.undercutsPerDay != null ? theirs.length / days : null, S = est?.cheapestSoldPerDay;
  if (!(depths.length >= o.minUndercuts) || U == null || S == null || !(U + S > 0)) return null;
  const sorted = [...depths].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { sellFirst: S / (U + S), undercutsPerDay: U, cheapestSoldPerDay: S, typicalDepth: at(0.5),
    secureDepth: Math.min(o.maxDepth, Math.max(o.minDepth, at(o.depthPercentile))), count: depths.length, ownExcluded: all.length - theirs.length };
}

/**
 * Suggested listing price for one item, from how crowded its market is now and how sales went in the past week.
 * - Crowded (3+ listed): just under the cheapest listing, but no higher than the typical recent sale price, so
 *   overpriced listings that aren't selling don't set your price.
 * - Thin (0-2 listed): the median price of sales that happened while the market was similarly thin (2 or fewer
 *   listed), when there are at least 2 of them; scarcity often lets higher prices sell. Capped at 1.5x the typical
 *   sale price. Without that history, just under the cheapest listing, or the typical sale price if nothing's listed.
 */
export function suggestListing(r, opts = LISTING_ADVICE) {
  const o = { ...LISTING_ADVICE, ...opts };
  const base = baseListing(r, o);
  const risk = undercutRisk(r.est, o, o.ownListings || []);
  const cheapest = r.listing > 0 ? r.listing : null;
  if (!risk || base.price == null || !cheapest) return { ...base, risk };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const mine = risk.ownExcluded ? ` (not counting ${risk.ownExcluded} of your own listing${risk.ownExcluded > 1 ? "s" : ""} from the Profit Calculator)` : "";
  const odds = `Undercuts are common here (${risk.undercutsPerDay.toFixed(1)}/day${mine} vs ${risk.cheapestSoldPerDay.toFixed(1)} sales of the cheapest/day), ` +
    `so a listing that's cheapest sells before being undercut only ~${pct(risk.sellFirst)} of the time.`;
  if (risk.sellFirst >= o.safeOdds) return { ...base, risk };
  // A surer sale: below where most undercutters land, but never below break-even.
  const secure = undercutPrice(cheapest * (1 - risk.secureDepth));
  const floor = o.breakEven > 0 ? Math.ceil(o.breakEven) : 0;
  if (secure >= base.price) return { ...base, risk, note: `${base.note} ${odds}` };
  if (secure < floor) {
    return { ...base, risk, basis: base.basis + "-risky",
      note: `${base.note} ${odds} Going deep enough to stay ahead of them (~${pct(risk.secureDepth)} under the cheapest) would sell at a loss, so expect to relist.` };
  }
  return { ...base, price: secure, basis: "secure", risk, givenUp: base.price - secure,
    note: `${odds} Undercutters usually go ~${pct(risk.typicalDepth)} under; listing ${pct(risk.secureDepth)} under the cheapest (${fmtK(cheapest)}) ` +
      `puts you below most of them for a surer sale, giving up ${fmtK(base.price - secure)} vs the ${fmtK(base.price)} you'd otherwise list at.` };
}

function baseListing(r, o) {
  const events = r.est?.events || [];
  const thinEvents = events.filter(([, n]) => n <= o.thinListings);
  const normalEvents = events.filter(([, n]) => n > o.thinListings);
  // The usual price: sales in a normal (not thin) market, so the thin-market premium isn't measured against itself.
  const normalUnits = normalEvents.reduce((t, e) => t + e[2], 0);
  const typical = (normalUnits >= 2 ? weightedMedian(normalEvents) : weightedMedian(events)) ?? (r.soldAvg > 0 ? r.soldAvg : null);
  const thinUnits = thinEvents.reduce((t, e) => t + e[2], 0);
  const thinMedian = thinUnits >= o.minThinSales ? weightedMedian(thinEvents) : null;
  const cheapest = r.listing > 0 ? r.listing : null;
  const listings = r.listings ?? 0;
  const premium = thinMedian && typical ? thinMedian / typical - 1 : null;
  if (listings > o.thinListings && cheapest) {
    if (typical && cheapest > typical * 1.1) {
      return { price: undercutPrice(typical), basis: "crowded-high", typical, thinMedian, premium, thinSales: thinUnits,
        note: `${listings} listed, but the cheapest (${fmtK(cheapest)}) is well above what's been selling (~${fmtK(typical)}), so list near recent sales.` };
    }
    return { price: undercutPrice(cheapest), basis: "crowded", typical, thinMedian, premium, thinSales: thinUnits,
      note: `${listings} listed: undercut the cheapest (${fmtK(cheapest)}) slightly to sell first.` };
  }
  if (thinMedian) {
    const cap = typical ? typical * o.maxPremium : Infinity;
    const target = Math.min(thinMedian, cap);
    // Never further below the cheapest listing than needed to sell first.
    const price = Math.max(undercutPrice(target + 1) || target, cheapest ? undercutPrice(cheapest) : 0);
    const behind = cheapest && cheapest < price ? ` The ${fmtK(cheapest)} listing will likely sell before yours.` : "";
    return { price, basis: "thin", typical, thinMedian, premium, thinSales: thinUnits,
      note: `${listings ? `Only ${listings} listed` : "Nothing listed"}. When it was this thin over the past week, ${thinUnits} sold at a median ${fmtK(thinMedian)}` +
        `${premium != null ? ` (${premium >= 0 ? "+" : ""}${Math.round(premium * 100)}% vs the usual ~${fmtK(typical)})` : ""}${thinMedian > cap ? `; capped at 1.5× the usual price` : ""}.${behind}` };
  }
  if (cheapest) {
    return { price: undercutPrice(cheapest), basis: "thin-no-history", typical, thinMedian, premium, thinSales: thinUnits,
      note: `Only ${listings} listed, but too few sales in a thin market last week to judge a premium; undercut the cheapest (${fmtK(cheapest)}).` };
  }
  if (typical) {
    return { price: undercutPrice(typical + 1), basis: "empty", typical, thinMedian, premium, thinSales: thinUnits,
      note: `Nothing listed; recent sales went for ~${fmtK(typical)}.` };
  }
  return { price: null, basis: "none", note: "No listings or recent sales to price from." };
}

function fmtK(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
  return String(Math.round(v));
}
