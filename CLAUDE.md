# Working on this repo

- **Don't deploy until Jonathan says so.** Every push to `main` triggers a deploy (`.github/workflows/deploy.yml`). Commit changes locally and test them locally (`python -m http.server -d site 8000`), but don't push (and don't trigger the workflow) until he asks to deploy, so several changes can go out in one deploy.
- The hourly/30-minute data refresh (cron-job.org → `workflow_dispatch`, plus the GitHub schedule) redeploys whatever is on `origin/main`; that's expected and doesn't need asking.
