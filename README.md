# Aion 2 crafting profit dashboard

A shareable dashboard that ranks Artisan's Splendent crafts on **Siel (Elyos, NA West)** by how much money they make **and** how fast they sell, including the True Dragon and Splendent True Dragon versions of each slot. All data comes from the public [aion2.exchange](https://aion2.exchange) API.

## How it works

```
GitHub Action (hourly) ──► aion2.exchange /api/servers, /api/crafts, /api/items
        │
        └─► site/data/snapshot.json ──► GitHub Pages ──► dashboard (index.html)
```

- `scripts/fetch_snapshot.py` pulls the crafting cost model (`/api/crafts`), current prices (`/api/items?keys=…`) and 10 days of hourly listing snapshots per item (`/api/items/{id}/prices?bucket=raw`) for Siel NAW. True Dragon items are derived from each craft target's key (tier code `13` → `15` True Dragon, `17` Splendent True Dragon); slots never listed on the server are skipped. It also prices the True Dragon recipe materials (`recipes/true_dragon.json`). Stdlib only, about 56 requests per run, rate-limited.
- `.github/workflows/deploy.yml` runs it hourly (and on every push to `main`) and deploys `site/` to GitHub Pages. The snapshot is deployed, not committed.
- The page **tries the live API first** and falls back to the snapshot. aion2.exchange doesn't currently send CORS headers, so browsers use the snapshot; if the API ever allows this origin, the page goes live automatically (refreshing every 5 minutes).

## Metrics

| Metric | Definition |
|---|---|
| Cost / craft | Artisan's Splendent: aion2.exchange's expected cost at mastery 100, cheapest path per input (or "buy everything"). True Dragon: see below |
| Sell price | Conservative: min(cheapest listing, avg sale price). Also selectable: listing only, or avg sale only |
| Profit / craft | sell price × (1 − 10% sales tax − 2% listing fee) − cost (both adjustable; assumes it sells on the first listing) |
| Sold / day | estimated from listing history (below); official 28-day stats are used instead where the game publishes them |
| Days of supply | current listings ÷ sold per day |
| Daily pool | profit / craft × sold / day; the ranking metric |
| Your daily | daily pool × your expected share of sales |
| Turnover / day | sell price after fees × sold / day: market size, available even without a crafting cost |

Verdicts: **Craft it** = profitable, ≥ 0.5 sold/day, ≤ 14 days of supply. Thresholds live in `site/metrics.js` (`DEFAULT_SETTINGS`).

Every control (tier, skill, price basis, tax, listing fee, share, sort) is stored in the URL, so a copied link reproduces the exact view.

## True Dragon crafting costs

`recipes/true_dragon.json` holds the 19 True Dragon recipes (Elyos), taken from the [questlog.gg crafting database](https://questlog.gg/aion-2/en/crafting). Each consumes the Artisan's Splendent item of the same slot plus five materials, and has a 25% combo chance to produce the Splendent True Dragon item instead (`trueDragonCost` in `site/metrics.js`):

- **One craft attempt** = Artisan's Splendent input + materials. The input costs the cheaper of crafting it (aion2.exchange's model) and buying it; under "buy everything" it's bought. Materials are priced at Siel's cheapest listing.
- **True Dragon** = one attempt. **Splendent True Dragon** = one attempt ÷ 0.25 = 4×, with the plain True Dragon results of the other attempts not credited (the same convention aion2.exchange uses for Artisan's Splendent).
- Not modelled yet: craft failure rates (aion2.exchange's model has ~93–97% success on the Artisan's steps), buying materials in bulk beyond the cheapest listing, and crafting the Horn/Leather/Scale intermediates yourself (they need NPC-bound tools whose price isn't on the exchange).

Recipes change only with game patches; regenerate the file if a patch changes them.

## Estimating sales from listing history

The game publishes no sales statistics for NA servers, so sales are inferred from the hourly listing snapshots (`estimateSales` in `site/metrics.js`), over the last 7 days:

- Listings that disappear between snapshots count as sales, unless they vanish ~72 h (±90 min) after appearing, which is when listings expire.
- If the count holds but the cheapest price jumps, the cheapest listing sold and was replaced: one sale.
- Each sale is priced at the cheapest listing just before it disappeared, which gives the estimated average sale price.
- Hourly snapshots miss listings posted and bought within the same hour, so the count is multiplied by 1.5 (`ESTIMATOR.captureAdjust`).

Validation: on EU server 11304, where these items are new enough that the game's daily change in its 28-day total equals that day's sales, the raw count caught 168 of 265 sales over 40 item-days; × 1.5 gives 252 (−5%). Per item the capture rate ranged from about 50% (Sapphire Ring, a fast seller) to ~100%, so single-item numbers are approximate. Cancelled listings are indistinguishable from sales.

## Run locally

```sh
python scripts/fetch_snapshot.py --out site/data/snapshot.json   # --limit 3 for a quick test
python -m http.server -d site 8000
```

## One-time setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then run the workflow once (Actions → "Refresh data and deploy dashboard" → Run workflow).
