#!/usr/bin/env python3
"""Pull crafting, price and listing-history data for Siel (Elyos, NA West) from aion2.exchange.

Covers the Artisan's Splendent craft targets plus the Expert's Splendent, True Dragon and Splendent True Dragon
version of each slot (no crafting cost yet). Writes one JSON snapshot the dashboard reads
(the API sends no CORS headers, so browsers on another origin can't call it directly).
True Dragon crafting costs use the recipes in recipes/true_dragon.json priced at Siel's
market; Expert's Splendent costs from the site's own model. About 96 requests per run.

Usage: python scripts/fetch_snapshot.py [--out site/data/snapshot.json] [--base URL] [--server ID]
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_BASE = "https://aion2.exchange"
DEFAULT_SERVER = 11201  # Siel · Elyos · North America West
RECIPES_DIR = Path(__file__).resolve().parent.parent / "recipes"
TD_RECIPES = RECIPES_DIR / "true_dragon.json"   # True Dragon (combo -> Splendent True Dragon)
HISTORY_DAYS = 10       # 7-day estimate window + 3 days so expiries of earlier listings can be matched
USER_AGENT = "a2marketanalyzer-dashboard/1.0 (+https://github.com/jonjonyue/a2marketanalyzer)"
DELAY_S = 0.25  # be gentle with the site: ~4 requests/second max

# Only the fields the dashboard uses, to keep the snapshot small.
TARGET_FIELDS = (
    "target_key", "name", "category", "skill", "profile_label",
    "cost", "cost_market", "carried", "missing",
    "market_price", "listings", "margin", "margin_pct",
)
# Item keys share a slot prefix and end in a tier code: Artisan's Splendent 13, True Dragon 15,
# Splendent True Dragon 17 (e.g. 110430013 / 110430015 / 110430017 are the three Bows).
# Expert's Splendent is one tier below Artisan's Splendent: key + 9999 (e.g. 110430013 -> 110440012).
EXPERT_TIER = "Expert's Splendent"
EXTRA_TIERS = ((EXPERT_TIER, 9999), ("True Dragon", 2), ("Splendent True Dragon", 4))
BASE_TIER = "Artisan's Splendent"

ITEM_FIELDS = (
    "item_key", "name", "price", "listings", "units_sold",
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
        except urllib.error.HTTPError as err:
            if err.code == 404:  # e.g. an item that has never been listed: nothing to retry
                return None
            last_err = err
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            last_err = err
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{url}: {last_err}")


def pick(obj: dict, fields: tuple[str, ...]) -> dict:
    return {k: obj.get(k) for k in fields}


def epoch_minutes(ts: str) -> int:
    return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() // 60)


def fetch_history(base: str, server_id: int, item_key: int, since: datetime) -> list[list]:
    """Every raw snapshot of the item since `since`: [epochMinutes, listings, cheapestPrice]."""
    resp = get_json(base, f"/api/items/{item_key}/prices", {
        "bucket": "raw",
        "from": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "server": server_id,
    }) or {}
    return [
        [epoch_minutes(p["ts"]), p.get("listings") or 0, p.get("low")]
        for p in resp.get("points") or []
        if p.get("ts")
    ]


def fetch_market(base: str, server_id: int) -> tuple[dict, dict | None, list[str]]:
    crafts = get_json(base, "/api/crafts", {"server": server_id})
    targets = [dict(pick(t, TARGET_FIELDS), tier=BASE_TIER) for t in crafts.get("targets") or []]
    extra_keys = {t["target_key"] + off: (tier, t) for t in targets for tier, off in EXTRA_TIERS}
    keys = [t["target_key"] for t in targets] + list(extra_keys)
    items: list[dict] = []
    if keys:
        time.sleep(DELAY_S)
        resp = get_json(base, "/api/items", {"keys": ",".join(map(str, keys)), "limit": 200, "server": server_id}) or {}
        items = [pick(i, ITEM_FIELDS) for i in resp.get("items") or []]

    errors: list[str] = []
    # Extra tiers share the craft target's slot, skill and category. Only items the site has market data
    # for (ever listed on this server) are included. Expert's Splendent costs come from the site's own model
    # (tier 2 of the Artisan's Splendent chain); True Dragon costs from recipes/true_dragon.json.
    for i in items:
        if i["item_key"] not in extra_keys:
            continue
        tier, base_t = extra_keys[i["item_key"]]
        cost = cost_market = None
        if tier == EXPERT_TIER:
            time.sleep(DELAY_S)
            try:
                detail = get_json(base, f"/api/crafts/{base_t['target_key']}", {"server": server_id}) or {}
                tr = next((x for x in detail.get("tiers") or [] if x.get("item_key") == i["item_key"]), {})
                cost, cost_market = tr.get("cost"), tr.get("cost_market")
            except Exception as err:
                errors.append(f"craft detail {base_t['target_key']}: {err}")
                print(errors[-1], file=sys.stderr)
        targets.append({
            "target_key": i["item_key"], "name": i.get("name"), "tier": tier,
            "category": base_t["category"], "skill": base_t["skill"], "profile_label": base_t["profile_label"],
            "cost": cost, "cost_market": cost_market, "carried": None, "missing": 0,
            "market_price": i.get("price"), "listings": i.get("listings"), "margin": None, "margin_pct": None,
        })
    keys = [t["target_key"] for t in targets]

    since = datetime.now(timezone.utc) - timedelta(days=HISTORY_DAYS)
    history: dict[str, list] = {}
    for key in keys:
        time.sleep(DELAY_S)
        try:
            history[str(key)] = fetch_history(base, server_id, key, since)
        except Exception as err:  # one item's history failing shouldn't sink the run
            errors.append(f"history {key}: {err}")
            print(errors[-1], file=sys.stderr)

    # True Dragon recipe materials, priced at the current cheapest listing on this server.
    td_recipes = json.loads(TD_RECIPES.read_text())
    mat_names = td_recipes["materials"]
    time.sleep(DELAY_S)
    resp = get_json(base, "/api/items", {"keys": ",".join(mat_names), "limit": 100, "server": server_id}) or {}
    priced = {str(i["item_key"]): i for i in resp.get("items") or []}
    materials = [
        {"item_key": int(k), "name": name, "price": (priced.get(k) or {}).get("price"),
         "listings": (priced.get(k) or {}).get("listings")}
        for k, name in mat_names.items()
    ]

    # Item icons: the site's icon index maps item key -> [file index, rarity index, ...].
    # The page loads the images straight from the site (/item-icons/{file}.webp).
    icons: dict[str, list] = {}
    time.sleep(DELAY_S)
    try:
        idx = get_json(base, "/item-icons/index.json") or {}
        files, rarities, entries = idx.get("files") or {}, idx.get("rarities") or [], idx.get("items") or {}
        for t in targets:
            e = entries.get(str(t["target_key"]))
            if not e:
                continue
            f = files.get(str(e[0])) if isinstance(files, dict) else (files[e[0]] if e[0] < len(files) else None)
            r = rarities[e[1]] if len(e) > 1 and isinstance(e[1], int) and e[1] < len(rarities) else {}
            if f:
                icons[str(t["target_key"])] = [f, r.get("color"), r.get("name")]
    except Exception as err:  # icons are cosmetic; never fail the run over them
        errors.append(f"icons: {err}")
        print(errors[-1], file=sys.stderr)

    market = {
        "captured_at": crafts.get("captured_at"),
        "targets": targets,
        "items": items,
        "history": history,
        "recipes": td_recipes["recipes"],
        "materials": materials,
        "icons": icons,
    }
    return market, crafts.get("model"), errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data/snapshot.json")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--server", type=int, default=DEFAULT_SERVER)
    args = ap.parse_args()

    servers = get_json(args.base, "/api/servers").get("servers", [])
    server = next((s for s in servers if s.get("server_id") == args.server), None)
    if server is None:
        print(f"Server {args.server} not found in /api/servers", file=sys.stderr)
        return 1

    market, model, errors = fetch_market(args.base, args.server)
    if market["targets"] and len(errors) > len(market["targets"]) / 2:
        print(f"Too many history failures ({len(errors)}); not writing snapshot.", file=sys.stderr)
        return 1

    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": args.base,
        "default_server": args.server,
        "model": model,
        "servers": [{k: server.get(k) for k in ("server_id", "name", "region", "region_name", "faction")}],
        "markets": {str(args.server): market},
        "errors": errors,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snapshot, separators=(",", ":")))
    points = sum(len(h) for h in market["history"].values())
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB): {len(market['targets'])} crafts, "
          f"{points} history points, {len(errors)} errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
