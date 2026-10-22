# Aion 2 crafting profit dashboard

A shareable dashboard that ranks Artisan's Splendent crafts on **NA West Siel (Elyos)** and **NA West Israphel (Asmodian)** by how much money they make **and** how fast they sell, including the Expert's Splendent, True Dragon and Splendent True Dragon versions of each slot. All data comes from the public [aion2.exchange](https://aion2.exchange) API.

## How it works

```
GitHub Action (hourly) ──► aion2.exchange /api/servers, /api/crafts, /api/items
        │
        └─► site/data/snapshot.json (server index) + site/data/servers/<id>.json ──► GitHub Pages ──► dashboard (index.html)
```

- `scripts/fetch_snapshot.py` pulls the crafting cost model (`/api/crafts`), current prices (`/api/items?keys=…`) and 10 days of hourly listing snapshots per item (`/api/items/{id}/prices?bucket=raw`) for NA West Siel and Israphel (`--servers` or `--regions` changes this), and writes one file per server plus an index. Related tiers are looked up per craft target, since their item keys differ by faction: Expert's Splendent from tier 2 of the site's cost chain, and True Dragon (Elyos, keys ending `15` / `17`) or Star Dragon (Asmodian, `19` / `21`) from `recipes/true_dragon.json`; slots never listed on the server are skipped. For each craft target it also keeps the site's full cost chain from `/api/crafts/{id}` (every step's materials, method, unit price, attempts, success rate and combo chance), which the dashboard shows when you expand a row. Expert's Splendent costs come from tier 2 of that chain. It also prices the True Dragon recipe materials (`recipes/true_dragon.json`) and reads the site's icon index (`/item-icons/index.json`), so the page can show each item's icon (loaded straight from aion2.exchange) framed in its rarity color. Stdlib only, about 96 requests per server (~200 per run), rate-limited.
- Requests retry up to 5 times, including responses cut off partway (`IncompleteRead`). A server that still fails keeps its last published file (`--fallback`, read back from the live site) and is marked `stale` in the index, so it never disappears from the server picker.
- `.github/workflows/deploy.yml` runs it every 20 minutes (GitHub skips many scheduled runs, so in practice it is roughly hourly; also on every push to `main`) builds the React app in `web/` (Vite, which copies `site/data/` into the build) and deploys `web/dist` to GitHub Pages. The snapshot is deployed, not committed.
- The page reads only the snapshot files (aion2.exchange's API sends no CORS headers, so a browser on another site can't read it; the page used to try anyway, which cost ~0.75 s per visit). The selected server's file is requested alongside the index.

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

**What to craft with your kinah** (`planBudget`): enter your kinah (saved in the browser as `a2dash.budget`, never in links) and the dashboard fills it with crafts worth making (Top pick / Craft it, within the current filters), best return on capital first. Each craft gets up to what the market has room for in the next 1.5 days (`marketRoom`, `planDays`; shorter than a 3-day listing so the plan stays flexible): your first unit sells once current listings clear; each extra only wins your share of the sales left after that, because other sellers keep relisting and your own copies compete with each other, so n = 1 + ⌊share × (sold/day × 1.5 − listings − 1)⌋. "Sells in" (`daysForUnits`) uses the same model. n units reserve cost per attempt × the attempts for 90% odds of n successes (`attemptsForN`, binomial), never less than n × the average cost. It reports expected profit, kinah set aside, what's left, and the best craft that didn't fit. Capital needed above your kinah is shown in orange. Your active listings in the Profit Calculator (unsold, not marked expired, under 3 days old) take their places in each item's room first: n = room − your units, where room is computed with your snapshot-time listings removed from the market's count (so they aren't counted twice); items your listings already fill are listed as covered. **List at** (`suggestListing`) depends on how crowded the market is: with 3+ listed, just under the cheapest listing but no higher than the typical sale price (median of recent sales in normal markets); with 0–2 listed, the median price of past-week sales that happened while the market was that thin (needs 2+ such sales; capped at 1.5× typical, never below just-under-the-cheapest). The sales estimator keeps each inferred sale with the listing count at the time (`events`) for this. Undercut risk (`undercutRisk`): the estimator also logs each undercut (the cheapest price dropping with no listing removed) and its depth. If a cheapest listing sells before being undercut less than 60% of the time (cheapest sales/day ÷ (undercuts/day + cheapest sales/day)), List at goes below where most undercutters land (75th-percentile depth, 2–15%) for a surer sale, never below break-even (cost ÷ (1 − tax − fee)); the hover says how much profit that gives up. Undercuts matching a listing logged in the Profit Calculator (same item, within the hour around the logged time, price within 1%; read from `a2ledger.v1` in the same browser) are excluded as your own. The plan's profit uses that price.

Verdicts, checked in this order (thresholds in `DEFAULT_SETTINGS` in `web/src/lib/metrics.js`):

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

The server picker is remembered in the browser (`localStorage` key `a2dash.server`, also used by the Profit Calculator for item prices) and kept in the URL (`?server=`); a link with a server shows it without changing the saved one. Every control (server, tier, skill, price basis, tax, listing fee, share, sort, expanded item) is stored in the URL, so a copied link reproduces the exact view.

## Crafting proficiency

Success rate depends on the proficiency advantage ΔL = your mastery − the recipe's level (`successAt` in `web/src/lib/metrics.js`, an approximate community formula):

- ΔL < 0: can't craft yet (verdict "Needs …").
- ΔL = 0: base rate, 74%.
- 0 < ΔL ≤ 45: base + (cap − base) × ln(ΔL + 1) ÷ ln(46).
- ΔL > 45: the cap.

Recipe levels come from aion2.exchange's model for the Splendent steps (e.g. weapons 3 / 15 / 30, Boots 10 / 25 / 40) and from questlog.gg for True Dragon (55 or 60, in `recipes/true_dragon.json`). Caps for the Splendent steps are the site's rates at mastery 100 (93.1% / 94.6% / 96.8%); True Dragon's cap isn't published and is assumed to be 96.8% (`PROFICIENCY.trueDragonCap`).

Artisan's and Expert's Splendent costs are recomputed from the site's cost chain at your success rates (`adjustChain`): each step needs 1 ÷ (success × combo) attempts per result, multiplied down the chain. At mastery 100 (and wherever every step is capped) this reproduces the site's costs exactly. True Dragon costs one attempt ÷ success (Splendent True Dragon: ÷ success × 25%). Settings are per skill, remembered in the browser (`localStorage` key `a2dash.proficiency`), and kept in the URL (`?prof=b60.r75`: b Blacksmithing, r Armorsmithing, h Handicrafting, a Alchemy); a link with `prof` shows those levels without overwriting the saved ones.

## True Dragon crafting costs

`recipes/true_dragon.json` holds the 19 True Dragon recipes (Elyos) and the 19 matching Star Dragon recipes (Asmodian, recipe id + 10,000,000; same materials, with Asvata Log in place of Yggdrasil Log for the bow and staff), taken from the [questlog.gg crafting database](https://questlog.gg/aion-2/en/crafting). Each consumes the Artisan's Splendent item of the same slot plus five materials, and has a 25% combo chance to produce the Splendent True Dragon item instead (`trueDragonCost` in `web/src/lib/metrics.js`):

- **One craft attempt** = Artisan's Splendent input + materials. The input costs the cheaper of crafting it (aion2.exchange's model) and buying it; under "buy everything" it's bought. Materials are priced at the server's cheapest listing.
- **True Dragon** = one attempt ÷ your success rate (see Crafting proficiency). **Splendent True Dragon** = that ÷ 0.25 = 4×, with the plain True Dragon results of the other attempts not credited (the same convention aion2.exchange uses for Artisan's Splendent).
- **Transfer craft** (recipe id = True Dragon recipe + 10, `transfer` in the recipe file): a True Dragon item plus 2 materials makes a Splendent True Dragon item that's bound to the character, so it can't be sold and doesn't set a seller's cost (the 25% combo is the only way to make a sellable one). It's shown as a reference in the expanded row (`transferCost`): True Dragon input at the cheaper of crafting and buying, plus materials, ÷ success (recipe level assumed equal to the True Dragon recipe's). A sell price above it gets a ▲, because buyers can transfer their own for less.
- Not modelled yet: buying materials in bulk beyond the cheapest listing, and crafting the Horn/Leather/Scale intermediates yourself (they need NPC-bound tools whose price isn't on the exchange).

Recipes change only with game patches; regenerate the file if a patch changes them.

## Estimating sales from listing history

The game publishes no sales statistics for NA servers, so sales are inferred from the hourly listing snapshots (`estimateSales` in `web/src/lib/metrics.js`), over the last 7 days:

- Listings that disappear between snapshots count as sales, unless they vanish ~72 h (±90 min) after appearing, which is when listings expire.
- If the count holds but the cheapest price jumps, the cheapest listing sold and was replaced: one sale.
- Each sale is priced at the cheapest listing just before it disappeared, which gives the estimated average sale price.
- Hourly snapshots miss listings posted and bought within the same hour, so the count is multiplied by a conservative 1.2 (`ESTIMATOR.captureAdjust`) and rounded to a tenth of a sale per day.

Validation: on EU server 11304, where these items are new enough that the game's daily change in its 28-day total equals that day's sales, the raw count caught 168 of 265 sales over 40 item-days (63%). A 1.5× adjustment would have matched in aggregate (252); the factor is set to 1.2× (202, about −24%) on purpose so the estimates err low. Per item the capture rate ranged from about 50% (Sapphire Ring, a fast seller) to ~100%, so single-item numbers are approximate. Cancelled listings are indistinguishable from sales.

## Profit calculator

The **Profit Calculator** tab (`#/ledger`; the old `ledger.html` redirects there) is a personal transaction log. Add entries as bought or sold with an item, quantity and the base price per unit (shorthand like `1.5m` or `250k` works); sales have the sales tax and listing fee (10% / 2% by default, adjustable) deducted automatically, and purchases cost the full price. A **Listed** entry charges the listing fee when posted and appears under Active listings, where it can be marked sold (fully or partly; those sales deduct only the tax), expired, or relisted with a new fee. It shows kinah made or lost, money received and spent, tax and fees paid, and a per-item breakdown (average buy/sell, profit, units on hand), filterable by period. Item suggestions and icons come from the dashboard's snapshot; any name can be typed.

**Your kinah** (shared with the dashboard's plan, `localStorage` key `a2dash.budget`) moves with every change to the log: a purchase subtracts what you paid, a listing its fee, a sale adds what you receive, and edits, deletes and undos reverse their effect; importing a backup doesn't touch it. The **What to craft with your kinah** plan also sits at the top of the calculator (`web/src/components/Plan.jsx` renders it for both pages), using the settings last used on Market Analysis in that browser (`a2dash.planSettings`: filters, share of sales, price and cost basis; plus proficiency), so it updates as you log entries. Entries are stored in the viewer's browser (`localStorage`, key `a2ledger.v1`), so each person who opens the link has their own private log. Export/import a JSON backup to move it between devices, or export CSV for a spreadsheet.

## Run locally

```sh
python scripts/fetch_snapshot.py --out site/data/snapshot.json   # --limit 3 for a quick test
cd web && npm install && npm run dev   # or: npm run build && python -m http.server -d dist 8000
```

## One-time setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then run the workflow once (Actions → "Refresh data and deploy dashboard" → Run workflow).
