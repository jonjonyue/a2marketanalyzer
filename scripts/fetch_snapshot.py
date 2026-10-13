#!/usr/bin/env python3
"""Pull crafting + sales data from the aion2.exchange public API for every server.

Writes one JSON snapshot the dashboard reads when it can't call the API directly
(the API sends no CORS headers, so browsers on another origin can't reach it).

Usage: python scripts/fetch_snapshot.py [--out site/data/snapshot.json] [--base URL]
Stdlib only, so the GitHub Action needs no installs.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_BASE = "https://aion2.exchange"
USER_AGENT = "a2marketanalyzer-dashboard/1.0 (+https://github.com/jonjonyue/a2marketanalyzer)"
DELAY_S = 0.25  # be gentle with the site: ~4 requests/second max

# Only the fields the dashboard uses, to keep the snapshot small.
TARGET_FIELDS = (
    "target_key", "name", "category", "skill", "profile_label",
    "cost", "cost_market", "carried", "missing",
    "market_price", "listings", "margin", "margin_pct",
)
ITEM_FIELDS = (
    "item_key", "price", "listings", "units_sold",
    "sold_avg_price", "sold_min_price", "sold_max_price",
    "stats_registered", "change_pct",
)


def get_json(base: str, path: str, params: dict | None = None, retries: int = 3):
    url = base.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            last_err = err
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{url}: {last_err}")


def pick(obj: dict, fields: tuple[str, ...]) -> dict:
    return {k: obj.get(k) for k in fields}


def fetch_market(base: str, server_id: int) -> dict:
    crafts = get_json(base, "/api/crafts", {"server": server_id})
    targets = crafts.get("targets") or []
    keys = [t["target_key"] for t in targets]
    items: list[dict] = []
    if keys:
        time.sleep(DELAY_S)
        resp = get_json(base, "/api/items", {"keys": ",".join(map(str, keys)), "limit": 100, "server": server_id})
        items = [pick(i, ITEM_FIELDS) for i in resp.get("items") or []]
    return {
        "captured_at": crafts.get("captured_at"),
        "targets": [pick(t, TARGET_FIELDS) for t in targets],
        "items": items,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data/snapshot.json")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--limit", type=int, default=0, help="only fetch the first N servers (for testing)")
    args = ap.parse_args()

    servers_resp = get_json(args.base, "/api/servers")
    servers = [s for s in servers_resp.get("servers", []) if s.get("has_data")]
    if args.limit:
        servers = servers[: args.limit]

    markets: dict[str, dict] = {}
    errors: dict[str, str] = {}
    model = None
    for s in servers:
        sid = s["server_id"]
        try:
            markets[str(sid)] = fetch_market(args.base, sid)
        except Exception as err:  # keep going; one bad server shouldn't sink the run
            errors[str(sid)] = str(err)
            print(f"server {sid}: {err}", file=sys.stderr)
        time.sleep(DELAY_S)

    # The cost model is the same for every server; grab it once for the methodology note.
    try:
        model = get_json(args.base, "/api/crafts", {"server": servers_resp.get("default")}).get("model")
    except Exception:
        model = None

    if servers and len(errors) > len(servers) / 2:
        print(f"Too many failures ({len(errors)}/{len(servers)}); not writing snapshot.", file=sys.stderr)
        return 1

    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": args.base,
        "default_server": servers_resp.get("default"),
        "model": model,
        "servers": [
            {k: s.get(k) for k in ("server_id", "name", "region", "region_name", "faction")}
            for s in servers
            if str(s["server_id"]) in markets
        ],
        "markets": markets,
        "errors": errors,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snapshot, separators=(",", ":")))
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB): {len(markets)} servers, {len(errors)} errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
