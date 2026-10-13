# Aion 2 crafting profit dashboard

A shareable dashboard that ranks Artisan's Splendent crafts on **Siel (Elyos, NA West)** by how much money they make **and** how fast they sell. All data comes from the public [aion2.exchange](https://aion2.exchange) API.

## How it works

```
GitHub Action (hourly) ──► aion2.exchange /api/servers, /api/crafts, /api/items
        │
        └─► site/data/snapshot.json ──► GitHub Pages ──► dashboard (index.html)
```

- `scripts/fetch_snapshot.py` pulls the crafting cost model (`/api/crafts`), current prices (`/api/items?keys=…`) and 10 days of hourly listing snapshots per craft (`/api/items/{id}/prices?bucket=raw`) for Siel NAW. Stdlib only, about 21 requests per run, rate-limited.
- `.github/workflows/deploy.yml` runs it hourly (and on every push to `main`) and deploys `site/` to GitHub Pages. The snapshot is deployed, not committed.
- The page **tries the live API first** and falls back to the snapshot. aion2.exchange doesn't currently send CORS headers, so browsers use the snapshot; if the API ever allows this origin, the page goes live automatically (refreshing every 5 minutes).

## Metrics

| Metric | Definition |
|---|---|
| Cost / craft | aion2.exchange's expected cost at mastery 100, cheapest path per input (or "buy everything") |
| Sell price | Conservative: min(cheapest listing, avg sale price). Also selectable: listing only, or avg sale only |
| Profit / craft | sell price × (1 − 10% sales tax − 2% listing fee) − cost (both adjustable; assumes it sells on the first listing) |
| Sold / day | estimated from listing history (below); official 28-day stats are used instead where the game publishes them |
| Days of supply | current listings ÷ sold per day |
| Daily pool | profit / craft × sold / day; the ranking metric |
| Your daily | daily pool × your expected share of sales |

Verdicts: **Craft it** = profitable, ≥ 0.5 sold/day, ≤ 14 days of supply. Thresholds live in `site/metrics.js` (`DEFAULT_SETTINGS`).

Every control (server, skill, price basis, tax, listing fee, share, sort) is stored in the URL, so a copied link reproduces the exact view.

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
