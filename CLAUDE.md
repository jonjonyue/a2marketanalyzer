# Working on this repo

- **Don't deploy until Jonathan says so.** Every push to `main` triggers a deploy (`.github/workflows/deploy.yml`). Commit changes locally and test them locally (`cd web && npm install && npm run dev`, or `npm run build` then `python -m http.server -d web/dist 8000`; market data goes in `site/data/` from `python scripts/fetch_snapshot.py`), but don't push (and don't trigger the workflow) until he asks to deploy, so several changes can go out in one deploy.
- The hourly/30-minute data refresh (cron-job.org → `workflow_dispatch`, plus the GitHub schedule) redeploys whatever is on `origin/main`; that's expected and doesn't need asking.
- The site is a Vite + React app in `web/` (one page; the Profit Calculator is the `#/ledger` tab). `web/src/lib/metrics.js` holds all the market math; `site/` only holds the fetched `data/` (never committed) and the `ledger.html` redirect, which the build copies into `web/dist`.
