#!/usr/bin/env python3
"""Pull crafting, price and listing-history data for NA West Siel (Elyos) and Israphel (Asmodian) from aion2.exchange.

Covers the Artisan's Splendent craft targets plus the Expert's Splendent, True Dragon and Splendent True Dragon
version of each slot (no crafting cost yet). Writes one JSON snapshot the dashboard reads
(the API sends no CORS headers, so browsers on another origin can't call it directly).
True Dragon crafting costs use the recipes in recipes/true_dragon.json priced at Siel's
market; Expert's Splendent costs from the site's own model. About 96 requests per run.

Writes one file per server (site/data/servers/<id>.json, about 96 requests each) plus an index
(site/data/snapshot.json) listing the servers and when each was refreshed.

Usage: python scripts/fetch_snapshot.py [--out site/data/snapshot.json] [--base URL] [--servers 11201,12201] [--regions NAE,NAW]
Stdlib only, so the GitHub Action needs no installs.
"""
from __future__ import annotations

import argparse
import http.client
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_BASE = "https://aion2.exchange"
DEFAULT_SERVER = 11201  # Siel · Elyos · North America West (the page's default)
DEFAULT_SERVERS = (11201, 12201)  # NA West: Siel (Elyos) and Israphel (Asmodian)
WORKERS = 3  # servers fetched in parallel; each still waits DELAY_S between its own requests
RECIPES_DIR = Path(__file__).resolve().parent.parent / "recipes"
TD_RECIPES = RECIPES_DIR / "true_dragon.json"   # True Dragon (combo -> Splendent True Dragon)
HISTORY_DAYS = 10       # 7-day estimate window + 3 days so expiries of earlier listings can be matched
USER_AGENT = "a2marketanalyzer-dashboard/1.0 (+https://github.com/jonjonyue/a2marketanalyzer)"
DELAY_S = float(__import__("os").environ.get("FETCH_DELAY_S", "0.25"))  # be gentle with the site: ~4 requests/second max

# Only the fields the dashboard uses, to keep the snapshot small.
TARGET_FIELDS = (
    "target_key", "name", "category", "skill", "profile_label",
    "cost", "cost_market", "carried", "missing",
    "market_price", "listings", "margin", "margin_pct",
)
# Each craft target (Artisan's Splendent) has three related tiers. Their item keys differ by faction
# (Elyos 110430013 -> Expert's 110440012, True Dragon 110430015, Splendent 110430017; Asmodian 110430014 ->
# 110440014, Star Dragon 110430019, Splendent 110430021), so they're looked up rather than computed:
# Expert's Splendent from tier 2 of the site's cost chain, True / Star Dragon from recipes/true_dragon.json.
# True Dragon and Star Dragon share the tier labels "True Dragon" / "Splendent True Dragon".
EXPERT_TIER = "Expert's Splendent"
TD_TIER, STD_TIER = "True Dragon", "Splendent True Dragon"
BASE_TIER = "Artisan's Splendent"

ITEM_FIELDS = (
    "item_key", "name", "price", "listings", "units_sold",
    "sold_avg_price", "sold_min_price", "sold_max_price",
    "stats_registered", "change_pct",
)


def get_json(base: str, path: str, params: dict | None = None, retries: int = 5):
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
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError,
                http.client.HTTPException, ConnectionError, OSError) as err:
            # HTTPException covers IncompleteRead: the site sometimes cuts a response off partway.
            last_err = err
            time.sleep(min(2 ** attempt, 10))
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


def fetch_icon_index(base: str) -> dict:
    """The site's icon index: item key -> [file index, rarity index, ...]. Shared by every server."""
    try:
        return get_json(base, "/item-icons/index.json") or {}
    except Exception as err:  # icons are cosmetic; never fail the run over them
        print(f"icons: {err}", file=sys.stderr)
        return {}


def fetch_market(base: str, server_id: int, icon_idx: dict | None = None) -> tuple[dict, dict | None, list[str]]:
    crafts = get_json(base, "/api/crafts", {"server": server_id})
    targets = [dict(pick(t, TARGET_FIELDS), tier=BASE_TIER) for t in crafts.get("targets") or []]
    td_recipes = json.loads(TD_RECIPES.read_text())

    errors: list[str] = []
    # The site's cost chain for each Artisan's Splendent target: every step's materials, method, unit price,
    # attempts, success rate and combo chance, plus the cost of each tier (Splendent, Expert's Splendent, ...).
    # The dashboard shows it as the recipe breakdown, and the Expert's Splendent cost is its tier 2.
    chains: dict[str, dict] = {}
    for bt in list(targets):
        time.sleep(DELAY_S)
        try:
            detail = get_json(base, f"/api/crafts/{bt['target_key']}", {"server": server_id}) or {}
        except Exception as err:
            errors.append(f"craft detail {bt['target_key']}: {err}")
            print(errors[-1], file=sys.stderr)
            continue
        chains[str(bt["target_key"])] = {
            "tiers": [pick(x, ("tier", "item_key", "name", "cost", "cost_market", "market_price")) for x in detail.get("tiers") or []],
            "steps": [{
                **pick(s, ("step_no", "recipe_id", "result_key", "result_name", "attempts", "success_rate",
                           "combo_probability", "step_cost", "mastery_level")),
                "materials": [pick(m, ("material_key", "name", "per_attempt", "expected", "unit_price",
                                       "listing_price", "method", "via", "subtotal")) for m in s.get("materials") or []],
            } for s in detail.get("steps") or []],
        }

    # Related tiers per target: Expert's Splendent (chain tier 2) and the True / Star Dragon pair from the recipes.
    recipe_by_base = {r["base_key"]: r for r in td_recipes["recipes"]}
    extra_keys: dict[int, tuple[str, dict]] = {}
    for t in targets:
        tier2 = next((x for x in (chains.get(str(t["target_key"])) or {}).get("tiers") or [] if x.get("tier") == 2), None)
        if tier2 and tier2.get("item_key"):
            extra_keys[tier2["item_key"]] = (EXPERT_TIER, t)
        r = recipe_by_base.get(t["target_key"])
        if r:
            extra_keys[r["product_key"]] = (TD_TIER, t)
            extra_keys[r["combo_key"]] = (STD_TIER, t)
    keys = [t["target_key"] for t in targets] + list(extra_keys)
    items: list[dict] = []
    if keys:
        time.sleep(DELAY_S)
        resp = get_json(base, "/api/items", {"keys": ",".join(map(str, keys)), "limit": 200, "server": server_id}) or {}
        items = [pick(i, ITEM_FIELDS) for i in resp.get("items") or []]

    # Extra tiers share the craft target's slot, skill and category. Only items the site has market data
    # for (ever listed on this server) are included. Expert's Splendent costs come from the site's own model
    # (tier 2 of the Artisan's Splendent chain); True Dragon costs from recipes/true_dragon.json.
    for i in items:
        if i["item_key"] not in extra_keys:
            continue
        tier, base_t = extra_keys[i["item_key"]]
        cost = cost_market = None
        if tier == EXPERT_TIER:
            chain = chains.get(str(base_t["target_key"])) or {}
            tr = next((x for x in chain.get("tiers") or [] if x.get("item_key") == i["item_key"]), {})
            cost, cost_market = tr.get("cost"), tr.get("cost_market")
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
    try:
        idx = icon_idx or {}
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
        "recipes": [r for r in td_recipes["recipes"] if r["base_key"] in recipe_by_base and
                    any(t["target_key"] == r["base_key"] for t in targets)],  # this server's faction only
        "materials": materials,
        "icons": icons,
        "chains": chains,
    }
    return market, crafts.get("model"), errors


SERVER_FIELDS = ("server_id", "name", "region", "region_name", "faction")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data/snapshot.json", help="index file; per-server files go in servers/ next to it")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--servers", default=",".join(map(str, DEFAULT_SERVERS)), help="comma-separated server ids")
    ap.add_argument("--regions", help="fetch every server in these region codes instead (NAE, NAW, EU, LA, AS)")
    ap.add_argument("--fallback", help="the published dashboard's URL: a server that fails this run keeps its last published file from there")
    args = ap.parse_args()

    all_servers = get_json(args.base, "/api/servers").get("servers", [])
    if args.regions:
        regions = {r.strip().upper() for r in args.regions.split(",") if r.strip()}
        servers = [s for s in all_servers if s.get("region") in regions]
    else:
        wanted = [int(x) for x in args.servers.split(",") if x.strip()]
        servers = sorted((s for s in all_servers if s.get("server_id") in wanted), key=lambda s: wanted.index(s["server_id"]))
    if not servers:
        print("No servers matched", file=sys.stderr)
        return 1
    out = Path(args.out)
    server_dir = out.parent / "servers"
    server_dir.mkdir(parents=True, exist_ok=True)
    icon_idx = fetch_icon_index(args.base)

    def one(server: dict) -> dict:
        sid = server["server_id"]
        info = {k: server.get(k) for k in SERVER_FIELDS}
        try:
            market, model, errors = fetch_market(args.base, sid, icon_idx)
        except Exception as err:
            print(f"server {sid}: {err}", file=sys.stderr)
            return {**info, "ok": False, "error": str(err)}
        if market["targets"] and len(errors) > len(market["targets"]) / 2:
            print(f"server {sid}: too many failures ({len(errors)}); keeping its previous file", file=sys.stderr)
            return {**info, "ok": False, "error": f"{len(errors)} request failures"}
        doc = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": args.base, "server": info, "model": model, "market": market, "errors": errors,
        }
        (server_dir / f"{sid}.json").write_text(json.dumps(doc, separators=(",", ":")))
        points = sum(len(h) for h in market["history"].values())
        print(f"{info['name']} {info['region']} {info['faction']}: {len(market['targets'])} crafts, {points} history points, {len(errors)} errors")
        return {**info, "ok": True, "generated_at": doc["generated_at"], "captured_at": market.get("captured_at"), "model": model}

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(one, servers))

    # A server that failed keeps its last published data rather than vanishing from the dashboard.
    if args.fallback:
        for r in results:
            if r["ok"]:
                continue
            sid = r["server_id"]
            try:
                doc = get_json(args.fallback, f"/data/servers/{sid}.json", {"run": int(time.time())}, retries=3)
            except Exception as err:
                print(f"server {sid}: no fallback ({err})", file=sys.stderr)
                continue
            if doc and doc.get("market"):
                (server_dir / f"{sid}.json").write_text(json.dumps(doc, separators=(",", ":")))
                r.update(stale=True, generated_at=doc.get("generated_at"), captured_at=(doc.get("market") or {}).get("captured_at"))
                print(f"server {sid}: kept the last published data from {doc.get('generated_at')}", file=sys.stderr)

    ok = [r for r in results if r["ok"]]
    if not ok:
        print(f"None of the {len(results)} servers fetched; not writing the index (the live site keeps its data).", file=sys.stderr)
        return 1
    model = next((r["model"] for r in ok if r.get("model")), None)
    index = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": args.base,
        "default_server": DEFAULT_SERVER,
        "model": model,
        # Servers that failed this run are listed only if their last published file was kept (marked stale).
        "servers": [{**{k: r.get(k) for k in (*SERVER_FIELDS, "generated_at", "captured_at")}, **({"stale": True} if r.get("stale") else {})}
                    for r in results if r["ok"] or r.get("stale")],
        "errors": [f"{r['name']} {r['region']}: {r['error']}" for r in results if not r["ok"]],
    }
    out.write_text(json.dumps(index, separators=(",", ":")))
    size = sum(f.stat().st_size for f in server_dir.glob("*.json")) / 1024 / 1024
    print(f"Wrote {out} and {len(ok)} server files ({size:.1f} MB); {len(results) - len(ok)} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
