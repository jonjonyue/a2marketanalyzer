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
       [--fallback URL] [--skip-unchanged]
Stdlib only, so the GitHub Action needs no installs.

With --skip-unchanged (and --fallback), it first asks /api/health: if the API is down, or no server has a snapshot newer
than the data already published, it makes no other requests and exits with SKIP_EXIT (3) so the workflow can skip
the deploy.
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
SKIP_EXIT = 3  # --skip-unchanged: nothing to do this run (API down, or no new snapshot since the published data)
ACTIVITY_KEEP_DAYS = 180  # hourly activity totals kept in each server file (the API itself keeps only ~10 days)
MAX_SKIP_AGE = timedelta(hours=3)  # refresh anyway once the published data is this old, in case health misreports
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
            # 503 / 429 mean the site is busy or rate-limiting: back off much longer (5, 10, 20, 40 s),
            # honouring Retry-After when it's sent.
            busy = err.code in (429, 502, 503, 504)
            wait = min(2 ** attempt, 10)
            if busy:
                retry_after = err.headers.get("Retry-After") if err.headers else None
                wait = int(retry_after) if retry_after and retry_after.isdigit() else 5 * 2 ** attempt
            time.sleep(min(wait, 60))
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


def activity_buckets(history: dict) -> dict[str, list[int]]:
    """Hourly market activity from one server's listing history, keyed by UTC epoch hour:
    [sales, undercuts, undercuts whose new cheapest sold before being undercut again, undercuts decided either way, snapshots].
    Same rules as the dashboard's activityProfile."""
    grid = sorted({p[0] for h in history.values() for p in h})
    out: dict[int, list[int]] = {}
    def bucket(t: int) -> list[int]:
        return out.setdefault(t // 60, [0, 0, 0, 0, 0])
    for t in grid:
        bucket(t)[4] += 1
    for h in history.values():
        if not h:
            continue
        by_t = {p[0]: p for p in h}
        tl = [(t, by_t[t][1], by_t[t][2]) if t in by_t else (t, 0, None) for t in grid if t >= h[0][0]]
        for i in range(1, len(tl)):
            (_, an, alow), (bt, bn, blow) = tl[i - 1], tl[i]
            d = bn - an
            sold = max(0, -d) or (1 if d == 0 and alow is not None and (blow is None or blow > alow) else 0)
            b = bucket(bt)
            b[0] += sold
            if d >= 0 and alow and blow and blow < alow:
                b[1] += 1
                for t2, _, low2 in tl[i + 1:]:  # did the new cheapest sell before someone went lower? (within 72h)
                    if t2 - bt > 72 * 60:
                        break
                    if low2 is not None and low2 < blow:
                        b[3] += 1
                        break
                    if low2 is None or low2 > blow:
                        b[2] += 1
                        b[3] += 1
                        break
    return {str(k): v for k, v in out.items()}


def merge_activity(previous: dict | None, history: dict) -> dict:
    """Recompute the hours this run's history covers (later snapshots can still settle an undercut's outcome) and keep
    older hours from the previously published file, for up to ACTIVITY_KEEP_DAYS."""
    fresh = activity_buckets(history)
    first = min((int(k) for k in fresh), default=None)
    hours = {k: v for k, v in ((previous or {}).get("hours") or {}).items() if first is None or int(k) < first}
    hours.update(fresh)
    latest = max((int(k) for k in hours), default=int(time.time() // 3600))
    cutoff = latest - ACTIVITY_KEEP_DAYS * 24
    return {"v": 1, "fields": ["sales", "undercuts", "sold_first", "decided", "snapshots"],
            "hours": {k: hours[k] for k in sorted(hours, key=int) if int(k) >= cutoff}}


def parse_time(v) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def needs_refresh(base: str, site: str | None, servers: list[int] | None) -> bool:
    """False when this run has nothing to do: the API is down, or no server has a snapshot newer than what's published."""
    try:
        get_json(base, "/api/health", retries=2)
    except Exception as err:
        print(f"aion2.exchange is unavailable ({err}); skipping this refresh and keeping the published data.")
        return False
    if not site:
        return True
    try:
        published = {s["server_id"]: s for s in (get_json(site, "/data/snapshot.json", {"run": int(time.time())}, retries=2) or {}).get("servers", [])}
    except Exception as err:
        print(f"Couldn't read the published data ({err}); refreshing.")
        return True
    now = datetime.now(timezone.utc)
    for sid in servers or list(published):
        pub = published.get(sid) or {}
        have, built = parse_time(pub.get("captured_at")), parse_time(pub.get("generated_at"))
        if pub.get("stale") or have is None or built is None or now - built > MAX_SKIP_AGE:
            print(f"server {sid}: published data is missing, stale or over {MAX_SKIP_AGE} old; refreshing.")
            return True
        try:
            latest = parse_time((get_json(base, "/api/health", {"server": sid}, retries=2) or {}).get("latest_snapshot_at"))
        except Exception as err:
            print(f"server {sid}: health check failed ({err}); skipping this refresh and keeping the published data.")
            return False
        if latest is None or latest > have + timedelta(seconds=60):
            print(f"server {sid}: new snapshot ({latest} vs published {have}); refreshing.")
            return True
    print("No new snapshots since the published data; skipping this refresh.")
    return False


def reuse_published(site: str, out: Path) -> int:
    """Copy the published index and every server file it lists, unchanged. All or nothing."""
    run = {"run": int(time.time())}
    try:
        index = get_json(site, "/data/snapshot.json", run, retries=3)
        servers = (index or {}).get("servers") or []
        if not servers:
            raise RuntimeError("the published index lists no servers")
        docs = {}
        for srv in servers:
            sid = srv["server_id"]
            doc = get_json(site, f"/data/servers/{sid}.json", run, retries=3)
            if not (doc and doc.get("market")):
                raise RuntimeError(f"server {sid}: no published file")
            docs[sid] = doc
    except Exception as err:
        print(f"Couldn't reuse the published data: {err}", file=sys.stderr)
        return 1
    server_dir = out.parent / "servers"
    server_dir.mkdir(parents=True, exist_ok=True)
    for sid, doc in docs.items():
        (server_dir / f"{sid}.json").write_text(json.dumps(doc, separators=(",", ":")))
    out.write_text(json.dumps(index, separators=(",", ":")))
    print(f"Reused the published data from {index.get('generated_at')} ({len(docs)} servers)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data/snapshot.json", help="index file; per-server files go in servers/ next to it")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--servers", default=",".join(map(str, DEFAULT_SERVERS)), help="comma-separated server ids")
    ap.add_argument("--regions", help="fetch every server in these region codes instead (NAE, NAW, EU, LA, AS)")
    ap.add_argument("--fallback", help="the published dashboard's URL: a server that fails this run keeps its last published file from there")
    ap.add_argument("--reuse", metavar="URL", help="don't call the API: copy the data already published at this dashboard URL "
                    "(for deploys that only change the site's code); exits 1 if any of it can't be read")
    ap.add_argument("--skip-unchanged", action="store_true", help="check /api/health first and exit 3 without fetching if the "
                    "API is down or has nothing newer than the data published at --fallback")
    args = ap.parse_args()
    if args.reuse:
        return reuse_published(args.reuse, Path(args.out))
    if args.skip_unchanged:
        wanted = [int(x) for x in args.servers.split(",") if x.strip()] if not args.regions else None
        if not needs_refresh(args.base, args.fallback, wanted):
            return SKIP_EXIT

    try:
        all_servers = get_json(args.base, "/api/servers").get("servers", [])
    except Exception as err:
        if not args.fallback:
            raise
        # The server list itself failed: use the published one so each server can still fall back.
        print(f"server list: {err}; using the published list", file=sys.stderr)
        all_servers = (get_json(args.fallback, "/data/snapshot.json", {"run": int(time.time())}, retries=2) or {}).get("servers", [])
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
        # Hourly activity builds up across runs: older hours come from the file already published.
        previous = None
        if args.fallback:
            try:
                previous = (get_json(args.fallback, f"/data/servers/{sid}.json", {"run": int(time.time())}, retries=2) or {}).get("activity")
            except Exception as err:
                print(f"server {sid}: couldn't read the published activity ({err}); starting from this run's history", file=sys.stderr)
        doc = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": args.base, "server": info, "model": model, "market": market, "errors": errors,
            "activity": merge_activity(previous, market["history"]),
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
    kept = [r for r in results if r.get("stale")]
    if not ok and not kept:
        print(f"None of the {len(results)} servers fetched and nothing to fall back on; not writing the index.", file=sys.stderr)
        return 1
    model = next((r["model"] for r in ok if r.get("model")), None)
    if model is None and args.fallback:  # every server fell back: keep the published model note too
        try:
            model = (get_json(args.fallback, "/data/snapshot.json", {"run": int(time.time())}, retries=2) or {}).get("model")
        except Exception:
            pass
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
