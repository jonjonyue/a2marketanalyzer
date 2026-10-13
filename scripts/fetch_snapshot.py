#!/usr/bin/env python3
"""Pull crafting, price and listing-history data for Siel (Elyos, NA West) from aion2.exchange.

Covers the Artisan's Splendent craft targets plus the True Dragon and Splendent True Dragon
version of each slot (no crafting cost yet). Writes one JSON snapshot the dashboard reads
(the API sends no CORS headers, so browsers on another origin can't call it directly).
True Dragon crafting costs use the recipes in recipes/true_dragon.json priced at Siel's
market, and the blue Artisan's gear from recipes/artisan.json. About 95 requests per run.

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
BLUE_RECIPES = RECIPES_DIR / "artisan.json"     # blue Artisan's gear (combo -> Artisan's Splendent)
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
EXTRA_TIERS = (("True Dragon", 2), ("Splendent True Dragon", 4))
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
    by_key = {t["target_key"]: t for t in targets}
    extra_keys = {t["target_key"] + off: (tier, t) for t in targets for tier, off in EXTRA_TIERS}
    td_recipes = json.loads(TD_RECIPES.read_text())
    blue_recipes = json.loads(BLUE_RECIPES.read_text())
    for r in blue_recipes["recipes"]:  # the blue item's slot is the Artisan's Splendent item it can combo into
        if r["combo_key"] in by_key:
            extra_keys[r["product_key"]] = (blue_recipes["tier"], by_key[r["combo_key"]])
    keys = [t["target_key"] for t in targets] + list(extra_keys)
    items: list[dict] = []
    if keys:
        time.sleep(DELAY_S)
        resp = get_json(base, "/api/items", {"keys": ",".join(map(str, keys)), "limit": 200, "server": server_id}) or {}
        items = [pick(i, ITEM_FIELDS) for i in resp.get("items") or []]

    # Extra tiers share the craft target's slot, skill and category; their cost comes from the recipe files.
    # Only items the site has market data for (ever listed on this server) are included.
    for i in items:
        if i["item_key"] in extra_keys:
            tier, base_t = extra_keys[i["item_key"]]
            targets.append({
                "target_key": i["item_key"], "name": i.get("name"), "tier": tier,
                "category": base_t["category"], "skill": base_t["skill"], "profile_label": base_t["profile_label"],
                "cost": None, "cost_market": None, "carried": None, "missing": 0,
                "market_price": i.get("price"), "listings": i.get("listings"), "margin": None, "margin_pct": None,
            })
    keys = [t["target_key"] for t in targets]

    since = datetime.now(timezone.utc) - timedelta(days=HISTORY_DAYS)
    history: dict[str, list] = {}
    errors: list[str] = []
    for key in keys:
        time.sleep(DELAY_S)
        try:
            history[str(key)] = fetch_history(base, server_id, key, since)
        except Exception as err:  # one item's history failing shouldn't sink the run
            errors.append(f"history {key}: {err}")
            print(errors[-1], file=sys.stderr)

    # Recipe materials and the Expert's Splendent inputs, priced at the cheapest listing on this server.
    mat_names = {**td_recipes["materials"], **blue_recipes["materials"]}
    input_names = blue_recipes["inputs"]
    time.sleep(DELAY_S)
    resp = get_json(base, "/api/items", {"keys": ",".join([*mat_names, *input_names]), "limit": 200, "server": server_id}) or {}
    priced = {str(i["item_key"]): i for i in resp.get("items") or []}
    materials = [
        {"item_key": int(k), "name": name, "price": (priced.get(k) or {}).get("price"),
         "listings": (priced.get(k) or {}).get("listings")}
        for k, name in mat_names.items()
    ]
    # Expert's Splendent craft cost = tier 2 of the site's Artisan's Splendent cost chain.
    inputs = []
    for r in blue_recipes["recipes"]:
        k = str(r["base_key"])
        craft_cost = None
        time.sleep(DELAY_S)
        try:
            detail = get_json(base, f"/api/crafts/{r['combo_key']}", {"server": server_id}) or {}
            craft_cost = next((tr.get("cost") for tr in detail.get("tiers") or [] if tr.get("item_key") == r["base_key"]), None)
        except Exception as err:
            errors.append(f"craft detail {r['combo_key']}: {err}")
            print(errors[-1], file=sys.stderr)
        inputs.append({"item_key": r["base_key"], "name": input_names.get(k), "craft_cost": craft_cost,
                       "price": (priced.get(k) or {}).get("price"), "listings": (priced.get(k) or {}).get("listings")})

    market = {
        "captured_at": crafts.get("captured_at"),
        "targets": targets,
        "items": items,
        "history": history,
        "recipes": td_recipes["recipes"] + blue_recipes["recipes"],
        "materials": materials,
        "inputs": inputs,
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
