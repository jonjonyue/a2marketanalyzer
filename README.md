# Aion 2 crafting profit dashboard

A shareable dashboard that ranks Artisan's Splendent crafts on **Siel (Elyos, NA West)** by how much money they make **and** how fast they sell, including the Expert's Splendent, True Dragon and Splendent True Dragon versions of each slot. All data comes from the public [aion2.exchange](https://aion2.exchange) API.

## How it works

```
GitHub Action (hourly) ──► aion2.exchange /api/servers, /api/crafts, /api/items
        │
        └─► site/data/snapshot.json ──► GitHub Pages ──► dashboard (index.html)
```

- `scripts/fetch_snapshot.py` pulls the crafting cost model (`/api/crafts`), current prices (`/api/items?keys=…`) and 10 days of hourly listing snapshots per item (`/api/items/{id}/prices?bucket=raw`) for Siel NAW. True Dragon items are derived from each craft target's key (tier code `13` → `15` True Dragon, `17` Splendent True Dragon); slots never listed on the server are skipped. For each craft target it also keeps the site's full cost chain from `/api/crafts/{id}` (every step's materials, method, unit price, attempts, success rate and combo chance), which the dashboard shows when you expand a row. Expert's Splendent items are the craft target's key + 9999 (e.g. `110430013` → `110440012`), with their cost taken from tier 2 of that chain. It also prices the True Dragon recipe materials (`recipes/true_dragon.json`) and reads the site's icon index (`/item-icons/index.json`), so the page can show each item's icon (loaded straight from aion2.exchange) framed in its rarity color. Stdlib only, about 96 requests per run, rate-limited.
- `.github/workflows/deploy.yml` runs it hourly (and on every push to `main`) and deploys `site/` to GitHub Pages. The snapshot is deployed, not committed.
- The page **tries the live API first** and falls back to the snapshot. aion2.exchange doesn't currently send CORS headers, so browsers use the snapshot; if the API ever allows this origin, the page goes live automatically (refreshing every 5 minutes).

## Metrics

| Metric | Definition |
|---|---|
| Cost / craft | Artisan's Splendent: aion2.exchange's expected cost at mastery 100, cheapest path per input (or "buy everything"). Expert's Splendent: tier 2 of the same model. True Dragon: see below |
| Sell price | Conservative: min(cheapest listing, avg sale price). Also selectable: listing only, or avg sale only |
| Profit / craft | sell price × (1 − 10% sales tax − 2% listing fee) − cost (both adjustable; assumes it sells on the first listing) |
| Sold / day | estimated from listing history (below); official 28-day stats are used instead where the game publishes them |
| Days of supply | current listings ÷ sold per day |
| Days to sell | (current listings + 1) ÷ sold per day: how long a listing you post now would wait (shown on hover) |
| Daily pool | profit / craft × sold / day; the ranking metric |
| Your daily | daily pool × your expected share of sales |
| Turnover / day | sell price after fees × sold / day: market size, available even without a crafting cost |
| Capital needed | barrier to entry: cost per attempt × attempts needed for a 90% chance of making one (`attemptsFor`). Combo crafts hit with chance success × combo per attempt, so an Artisan's Splendent (~24%) needs 9 attempts' worth, about 2.2× its average cost; True Dragon needs 1 |
| Return on capital | profit / craft ÷ capital needed: profit per kinah you have to put up |
| Proficiency | per-skill crafting mastery (1–100: Novice 1–50, Professional 1–50; default Professional 25 = 75). Sets every craft's success rate (below) |

Verdicts, checked in this order (thresholds in `DEFAULT_SETTINGS` in `site/metrics.js`):

| Verdict | Rule |
|---|---|
| Loss | profit ≤ 0 |
| Oversupplied | over 5 days of supply, listings ÷ sold/day (`maxSupplyDays`); listings last 3 days |
| Slow seller | a new listing would wait over 3 days to sell: (listings + 1) ÷ sold/day > `listingDays`, so it would likely expire first |
| Low return | under 15% return on capital (`minRoc`) |
| Top pick | ≥ 50% return on capital, ≥ 1 sold/day, ≤ 3 days of supply (`topRoc`, `topSalesPerDay`, `topSupplyDays`) |
| Craft it | everything else that's profitable and selling |

Items that can't be judged yet get a status instead: Needs … (mastery too low), Cost TBD, Cost incomplete, No sales data, No price.

Click an item to expand its recipe, laid out like the game's: every input (including the gear it consumes) with its market price and crafted price, the one used highlighted, and the cost per attempt. Each crafted input has a nested "How … is made" recipe, all the way down (True Dragon → Artisan's Splendent → Expert's Splendent → Splendent), with the success and combo maths that turn a per-attempt cost into a per-item cost. The ↗ button opens the item on aion2.exchange.

Every control (tier, skill, price basis, tax, listing fee, share, sort, expanded item) is stored in the URL, so a copied link reproduces the exact view.

## Crafting proficiency

Success rate depends on the proficiency advantage ΔL = your mastery − the recipe's level (`successAt` in `site/metrics.js`, an approximate community formula):

- ΔL < 0: can't craft yet (verdict "Needs …").
- ΔL = 0: base rate, 74%.
- 0 < ΔL ≤ 45: base + (cap − base) × ln(ΔL + 1) ÷ ln(46).
- ΔL > 45: the cap.

Recipe levels come from aion2.exchange's model for the Splendent steps (e.g. weapons 3 / 15 / 30, Boots 10 / 25 / 40) and from questlog.gg for True Dragon (55 or 60, in `recipes/true_dragon.json`). Caps for the Splendent steps are the site's rates at mastery 100 (93.1% / 94.6% / 96.8%); True Dragon's cap isn't published and is assumed to be 96.8% (`PROFICIENCY.trueDragonCap`).

Artisan's and Expert's Splendent costs are recomputed from the site's cost chain at your success rates (`adjustChain`): each step needs 1 ÷ (success × combo) attempts per result, multiplied down the chain. At mastery 100 (and wherever every step is capped) this reproduces the site's costs exactly. True Dragon costs one attempt ÷ success (Splendent True Dragon: ÷ success × 25%). Settings are per skill and kept in the URL (`?prof=b60.r75`: b Blacksmithing, r Armorsmithing, h Handicrafting, a Alchemy).

## True Dragon crafting costs

`recipes/true_dragon.json` holds the 19 True Dragon recipes (Elyos), taken from the [questlog.gg crafting database](https://questlog.gg/aion-2/en/crafting). Each consumes the Artisan's Splendent item of the same slot plus five materials, and has a 25% combo chance to produce the Splendent True Dragon item instead (`trueDragonCost` in `site/metrics.js`):

- **One craft attempt** = Artisan's Splendent input + materials. The input costs the cheaper of crafting it (aion2.exchange's model) and buying it; under "buy everything" it's bought. Materials are priced at Siel's cheapest listing.
- **True Dragon** = one attempt ÷ your success rate (see Crafting proficiency). **Splendent True Dragon** = that ÷ 0.25 = 4×, with the plain True Dragon results of the other attempts not credited (the same convention aion2.exchange uses for Artisan's Splendent).
- The direct Splendent True Dragon recipes that craft from True Dragon gear (item IDs ending `096`) are left out on purpose: they're transfer crafts, so the result is bound to the player and can't be sold. The 25% combo is the only way to make a sellable Splendent True Dragon.
- Not modelled yet: buying materials in bulk beyond the cheapest listing, and crafting the Horn/Leather/Scale intermediates yourself (they need NPC-bound tools whose price isn't on the exchange).

Recipes change only with game patches; regenerate the file if a patch changes them.

## Estimating sales from listing history

The game publishes no sales statistics for NA servers, so sales are inferred from the hourly listing snapshots (`estimateSales` in `site/metrics.js`), over the last 7 days:

- Listings that disappear between snapshots count as sales, unless they vanish ~72 h (±90 min) after appearing, which is when listings expire.
- If the count holds but the cheapest price jumps, the cheapest listing sold and was replaced: one sale.
- Each sale is priced at the cheapest listing just before it disappeared, which gives the estimated average sale price.
- Hourly snapshots miss listings posted and bought within the same hour, so the count is multiplied by a conservative 1.2 (`ESTIMATOR.captureAdjust`) and rounded to a tenth of a sale per day.

Validation: on EU server 11304, where these items are new enough that the game's daily change in its 28-day total equals that day's sales, the raw count caught 168 of 265 sales over 40 item-days (63%). A 1.5× adjustment would have matched in aggregate (252); the factor is set to 1.2× (202, about −24%) on purpose so the estimates err low. Per item the capture rate ranged from about 50% (Sapphire Ring, a fast seller) to ~100%, so single-item numbers are approximate. Cancelled listings are indistinguishable from sales.

## Run locally

```sh
python scripts/fetch_snapshot.py --out site/data/snapshot.json   # --limit 3 for a quick test
python -m http.server -d site 8000
```

## One-time setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then run the workflow once (Actions → "Refresh data and deploy dashboard" → Run workflow).
