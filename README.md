# Aion 2 crafting profit dashboard

A shareable dashboard that ranks Artisan's Splendent crafts by how much money they make **and** how fast they sell, on every Aion 2 server. All data comes from the public [aion2.exchange](https://aion2.exchange) API.

## How it works

```
GitHub Action (hourly) ──► aion2.exchange /api/servers, /api/crafts, /api/items
        │
        └─► site/data/snapshot.json ──► GitHub Pages ──► dashboard (index.html)
```

- `scripts/fetch_snapshot.py` pulls, for every server with data, the crafting cost model (`/api/crafts?server=…`) and the 28-day sales stats for those items (`/api/items?keys=…&server=…`). Stdlib only, about two requests per server, rate-limited.
- `.github/workflows/deploy.yml` runs it hourly (and on every push to `main`) and deploys `site/` to GitHub Pages. The snapshot is deployed, not committed.
- The page **tries the live API first** and falls back to the snapshot. aion2.exchange doesn't currently send CORS headers, so browsers use the snapshot; if the API ever allows this origin, the page goes live automatically (refreshing every 5 minutes).

## Metrics

| Metric | Definition |
|---|---|
| Cost / craft | aion2.exchange's expected cost at mastery 100, cheapest path per input (or "buy everything") |
| Sell price | Conservative: min(cheapest listing, 28-day avg sale). Also selectable: listing only, or avg sale only |
| Profit / craft | sell price × (1 − 10% sales tax − 2% listing fee) − cost (both adjustable; assumes it sells on the first listing) |
| Sold / day | units sold in 28 days ÷ 28 |
| Days of supply | current listings ÷ sold per day |
| Daily pool | profit / craft × sold / day; the ranking metric |
| Your daily | daily pool × your expected share of sales |

Verdicts: **Craft it** = profitable, ≥ 0.5 sold/day, ≤ 14 days of supply. Thresholds live in `site/metrics.js` (`DEFAULT_SETTINGS`).

Every control (server, skill, price basis, tax, listing fee, share, sort) is stored in the URL, so a copied link reproduces the exact view.

## Run locally

```sh
python scripts/fetch_snapshot.py --out site/data/snapshot.json   # --limit 3 for a quick test
python -m http.server -d site 8000
```

## One-time setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then run the workflow once (Actions → "Refresh data and deploy dashboard" → Run workflow).
