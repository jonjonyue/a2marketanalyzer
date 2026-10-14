import { analyzeMarket, DEFAULT_SETTINGS, ESTIMATOR, VERDICT_ORDER, byRank } from "./metrics.js";

const API = "https://aion2.exchange";
const SNAPSHOT_URL = "data/snapshot.json";
const SERVER_ID = 11201; // the dashboard covers Siel · Elyos, North America West only
const HISTORY_DAYS = 10;
const SKILLS = ["All", "Blacksmithing", "Tailoring", "Jewelcrafting", "Alchemy"];
const TIERS = ["All", "Expert's Splendent", "Artisan's Splendent", "True Dragon", "Splendent True Dragon"];
const TIER_PARAM = { "Expert's Splendent": "es", "Artisan's Splendent": "as", "True Dragon": "td", "Splendent True Dragon": "std" };

const $ = (id) => document.getElementById(id);
const state = {
  mode: null,          // "live" | "snapshot"
  servers: [],
  snapshot: null,
  market: null,        // { captured_at, targets, items }
  rows: [],
  ui: readUrl(),
};

// ---------- formatting ----------
function kinah(v, { sign = false } = {}) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
  return s + Math.round(a);
}
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + "%");
const rate = (v) => (v == null ? "—" : v.toFixed(1));
const days = (v) => (v == null ? "—" : v === Infinity ? "∞" : v >= 100 ? "99+" : v.toFixed(1));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ago(iso) {
  if (!iso) return "unknown";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// ---------- URL state (so a copied link reproduces the view) ----------
function readUrl() {
  const p = new URLSearchParams(location.search);
  const n = (k, d) => (p.has(k) && Number.isFinite(+p.get(k)) ? +p.get(k) : d);
  return {
    server: SERVER_ID,
    skill: SKILLS.includes(p.get("skill")) ? p.get("skill") : "All",
    tier: Object.keys(TIER_PARAM).find((k) => TIER_PARAM[k] === p.get("tier")) || "All",
    priceBasis: ["conservative", "listing", "sold"].includes(p.get("price")) ? p.get("price") : DEFAULT_SETTINGS.priceBasis,
    costBasis: ["cheapest", "market"].includes(p.get("cost")) ? p.get("cost") : DEFAULT_SETTINGS.costBasis,
    salesTaxPct: Math.min(50, Math.max(0, n("tax", DEFAULT_SETTINGS.salesTaxPct))),
    listingFeePct: Math.min(50, Math.max(0, n("listfee", DEFAULT_SETTINGS.listingFeePct))),
    sharePct: Math.min(100, Math.max(1, n("share", DEFAULT_SETTINGS.sharePct))),
    hideLoss: p.get("hideLoss") === "1",
    open: p.has("open") ? +p.get("open") : null,
    sort: p.get("sort") || "rank",
    dir: p.get("dir") === "asc" ? "asc" : "desc",
  };
}
function writeUrl() {
  const u = state.ui;
  const p = new URLSearchParams();
  if (u.skill !== "All") p.set("skill", u.skill);
  if (u.tier !== "All") p.set("tier", TIER_PARAM[u.tier]);
  if (u.priceBasis !== DEFAULT_SETTINGS.priceBasis) p.set("price", u.priceBasis);
  if (u.costBasis !== DEFAULT_SETTINGS.costBasis) p.set("cost", u.costBasis);
  if (u.salesTaxPct !== DEFAULT_SETTINGS.salesTaxPct) p.set("tax", u.salesTaxPct);
  if (u.listingFeePct !== DEFAULT_SETTINGS.listingFeePct) p.set("listfee", u.listingFeePct);
  if (u.sharePct !== DEFAULT_SETTINGS.sharePct) p.set("share", u.sharePct);
  if (u.hideLoss) p.set("hideLoss", "1");
  if (u.open != null) p.set("open", u.open);
  if (u.sort !== "rank") { p.set("sort", u.sort); p.set("dir", u.dir); }
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---------- data loading: live API first, hourly snapshot as fallback ----------
async function fetchJson(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function init() {
  try {
    const s = await fetchJson(`${API}/api/servers`, 4000);
    state.mode = "live";
    state.servers = s.servers.filter((x) => x.server_id === SERVER_ID);
  } catch {
    // Expected while the API doesn't send CORS headers: use the snapshot the GitHub Action builds.
    try {
      state.snapshot = await fetchJson(SNAPSHOT_URL, 20000);
    } catch (err) {
      showBanner("Couldn't load market data. The snapshot hasn't been built yet, or the site is unreachable.");
      $("freshness").textContent = "No data";
      return;
    }
    state.mode = "snapshot";
    state.servers = state.snapshot.servers;
    if (state.snapshot.model) setModelNote(state.snapshot.model);
  }
  const srv = state.servers[0];
  if (srv) $("serverName").textContent = `${srv.name} · ${srv.faction} · ${srv.region_name || srv.region}`;
  buildControls();
  await loadMarket();
  if (state.mode === "live") setInterval(loadMarket, 5 * 60 * 1000);
}

async function loadMarket() {
  const sid = state.ui.server;
  if (state.mode === "snapshot") {
    state.market = state.snapshot.markets[String(sid)] || { targets: [], items: [] };
  } else {
    try {
      const crafts = await fetchJson(`${API}/api/crafts?server=${sid}`);
      const keys = crafts.targets.map((t) => t.target_key).join(",");
      const items = keys ? await fetchJson(`${API}/api/items?keys=${keys}&limit=100&server=${sid}`) : { items: [] };
      const since = new Date(Date.now() - HISTORY_DAYS * 86400e3).toISOString();
      const history = {};
      for (const t of crafts.targets) {
        const h = await fetchJson(`${API}/api/items/${t.target_key}/prices?bucket=raw&from=${since}&server=${sid}`);
        history[t.target_key] = (h.points || []).map((p) => [Math.floor(new Date(p.ts).getTime() / 60000), p.listings || 0, p.low]);
      }
      const icons = {};
      try {
        const idx = await fetchJson(`${API}/item-icons/index.json`);
        for (const t of crafts.targets) {
          const e = idx.items?.[t.target_key];
          const r = e && idx.rarities?.[e[1]];
          if (e && idx.files?.[e[0]]) icons[t.target_key] = [idx.files[e[0]], r?.color, r?.name];
        }
      } catch { /* icons are optional */ }
      state.market = { captured_at: crafts.captured_at, targets: crafts.targets, items: items.items, history, icons };
      if (crafts.model) setModelNote(crafts.model);
    } catch {
      showBanner("Lost connection to aion2.exchange; showing the last data loaded.");
    }
  }
  setFreshness();
  render();
}

function setFreshness() {
  const el = $("freshness");
  const captured = state.market?.captured_at;
  if (state.mode === "live") {
    el.className = "freshness live";
    el.innerHTML = `<span class="dot"></span>Live · prices ${esc(ago(captured))}`;
  } else {
    const gen = state.snapshot.generated_at;
    const stale = Date.now() - new Date(gen).getTime() > 3 * 3600e3;
    el.className = "freshness" + (stale ? " stale" : "");
    el.innerHTML = `<span class="dot"></span>Updated ${esc(ago(gen))} · prices ${esc(ago(captured))}`;
    el.title = `Snapshot built ${new Date(gen).toLocaleString()}; refreshed hourly`;
  }
}

function setModelNote(m) {
  $("modelNote").textContent = `Cost model #${m.model_id ?? "?"} (algorithm v${m.algorithm_version ?? "?"}, mastery ${m.mastery ?? "?"}), built from game files.`;
}

function showBanner(msg) {
  let b = document.querySelector(".banner");
  if (!b) {
    b = document.createElement("div");
    b.className = "banner";
    b.setAttribute("role", "alert");
    document.querySelector("main").prepend(b);
  }
  b.textContent = msg;
}

// ---------- controls ----------
function buildControls() {
  $("tiers").innerHTML = TIERS.map((s) => `<button type="button" data-v="${s}">${s}</button>`).join("");
  $("tiers").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.ui.tier = b.dataset.v; syncControls(); writeUrl(); render();
  });
  $("skills").innerHTML = SKILLS.map((s) => `<button type="button" data-v="${s}">${s}</button>`).join("");
  $("skills").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.ui.skill = b.dataset.v; syncControls(); writeUrl(); render();
  });

  for (const id of ["priceBasis", "costBasis"]) {
    const group = $(id);
    group.querySelectorAll("button").forEach((b) => { b.type = "button"; b.setAttribute("role", "radio"); });
    group.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.ui[id] = b.dataset.v; syncControls(); writeUrl(); render();
    });
  }

  const num = (id, key, lo, hi) => {
    const el = $(id);
    el.value = state.ui[key];
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      state.ui[key] = Math.min(hi, Math.max(lo, v)); writeUrl(); render();
    });
  };
  num("tax", "salesTaxPct", 0, 50);
  num("listFee", "listingFeePct", 0, 50);
  num("share", "sharePct", 1, 100);

  $("hideLoss").checked = state.ui.hideLoss;
  $("hideLoss").addEventListener("change", (e) => { state.ui.hideLoss = e.target.checked; writeUrl(); render(); });

  $("copyLink").addEventListener("click", async () => {
    const btn = $("copyLink");
    try { await navigator.clipboard.writeText(location.href); btn.textContent = "Link copied"; }
    catch { btn.textContent = "Copy the address bar"; }
    setTimeout(() => (btn.textContent = "Copy share link"), 1800);
  });
  syncControls();
}

function syncControls() {
  $("skills").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.ui.skill)));
  $("tiers").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.ui.tier)));
  for (const id of ["priceBasis", "costBasis"]) {
    $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === state.ui[id])));
  }
}

// ---------- render ----------
function render() {
  if (!state.market) return;
  const settings = { ...DEFAULT_SETTINGS, ...state.ui };
  let rows = analyzeMarket(state.market, settings);
  rows.forEach((r, i) => (r.rank = i + 1)); // rank within the whole server, before filters
  if (state.ui.tier !== "All") rows = rows.filter((r) => r.tier === state.ui.tier);
  if (state.ui.skill !== "All") rows = rows.filter((r) => r.skill === state.ui.skill);
  if (state.ui.hideLoss) rows = rows.filter((r) => !(r.profit != null && r.profit <= 0));
  state.rows = rows;
  renderKpis(rows);
  renderBars(rows);
  renderScatter(rows, settings);
  renderTable(rows);
}

// True Dragon tiers have no crafting cost yet; when nothing in view has one, show market size instead of profit.
const noCostsInView = (rows) => rows.length > 0 && rows.every((r) => r.cost == null);

function renderKpis(rows) {
  if (noCostsInView(rows)) return renderMarketKpis(rows);
  const good = rows.filter((r) => r.verdict.id === "craft");
  const best = [...rows].sort(byRank)[0];
  const pool = rows.reduce((s, r) => s + Math.max(0, r.dailyPool ?? 0), 0);
  const margins = rows.map((r) => r.marginPct).filter((v) => v != null).sort((a, b) => a - b);
  const median = margins.length ? margins[Math.floor(margins.length / 2)] : null;
  const yours = best?.yourDaily;
  // Best return on the capital you have to put up, among crafts that are profitable and actually selling.
  const bestRoc = rows.filter((r) => r.roc != null && r.roc > 0 && r.perDay != null && r.perDay >= DEFAULT_SETTINGS.minSalesPerDay)
    .sort((a, b) => b.roc - a.roc)[0];
  const tiles = [
    { label: "Best craft right now", value: best && best.dailyPool > 0 ? best.shortName : "Nothing profitable", sub: best && best.dailyPool > 0 ? `${kinah(best.profit)} per craft · ${rate(best.perDay)}/day sold` : "Try another price basis" },
    { label: "Your expected daily profit", value: yours > 0 ? kinah(yours) : "—", sub: yours > 0 ? `from ${best.shortName} at ${state.ui.sharePct}% share` : "No craft with positive profit and sales" },
    { label: "Worth crafting", value: `${good.length} of ${rows.filter((r) => r.cost != null).length}`, sub: costedNote(rows) },
    bestRoc
      ? { label: "Best return on capital", value: bestRoc.shortName, sub: `${pct(bestRoc.roc)} · ${kinah(bestRoc.profit)} profit on ${kinah(bestRoc.capital)}` }
      : { label: "Median margin", value: pct(median), sub: `market-wide daily pool ${kinah(pool)}` },
  ];
  $("kpis").innerHTML = tiles.map((t) => `<div class="kpi"><div class="label">${esc(t.label)}</div><div class="value" title="${esc(t.value)}">${esc(t.value)}</div><div class="sub" title="${esc(t.sub)}">${esc(t.sub)}</div></div>`).join("");
}

function renderMarketKpis(rows) {
  const byTurnover = rows.filter((r) => r.turnover != null).sort((a, b) => b.turnover - a.turnover);
  const fastest = rows.filter((r) => r.perDay != null).sort((a, b) => b.perDay - a.perDay)[0];
  const total = byTurnover.reduce((s, r) => s + r.turnover, 0);
  const top = byTurnover[0];
  const tiles = [
    { label: "Biggest market", value: top ? top.shortName : "—", sub: top ? `${kinah(top.turnover)} / day after fees` : "No sales estimates yet" },
    { label: "Fastest seller", value: fastest ? fastest.shortName : "—", sub: fastest ? `~${rate(fastest.perDay)} sold / day` : "No sales estimates yet" },
    { label: "Total turnover", value: kinah(total), sub: `per day across ${byTurnover.length} items, after fees` },
    { label: "Crafting cost", value: "TBD", sub: "profit and ranking need a cost model" },
  ];
  $("kpis").innerHTML = tiles.map((t) => `<div class="kpi"><div class="label">${esc(t.label)}</div><div class="value" title="${esc(t.value)}">${esc(t.value)}</div><div class="sub" title="${esc(t.sub)}">${esc(t.sub)}</div></div>`).join("");
}

function costedNote(rows) {
  const tbd = rows.filter((r) => r.cost == null).length;
  return tbd ? `of crafts with a known cost; ${tbd} with cost TBD` : "profitable, selling, not oversupplied";
}

// ----- tooltip -----
const tip = $("tooltip");
function showTip(e, r) {
  tip.innerHTML = `<strong class="tip-title">${iconHtml(r.key, "small")}${esc(r.shortName)}</strong>
    <div class="row"><span>Profit / craft</span><span>${kinah(r.profit, { sign: true })}</span></div>
    <div class="row"><span>Margin</span><span>${pct(r.marginPct)}</span></div>
    <div class="row"><span>Capital needed</span><span>${kinah(r.capital)}</span></div>
    <div class="row"><span>Return on capital</span><span>${pct(r.roc)}</span></div>
    <div class="row"><span>Sold / day${r.salesSource === "estimate" ? " (est.)" : ""}</span><span>${rate(r.perDay)}</span></div>
    <div class="row"><span>Listings</span><span>${r.listings}</span></div>
    <div class="row"><span>Daily pool</span><span>${kinah(r.dailyPool)}</span></div>
    <div class="row"><span>Turnover / day</span><span>${kinah(r.turnover)}</span></div>
    <div class="row"><span>Verdict</span><span>${esc(r.verdict.label)}</span></div>`;
  tip.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > innerHeight - 8) y = e.clientY - h - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => (tip.hidden = true);
function wireTips(container, rows) {
  container.querySelectorAll("[data-i]").forEach((el) => {
    const r = rows[+el.dataset.i];
    el.addEventListener("mouseenter", (e) => showTip(e, r));
    el.addEventListener("mousemove", moveTip);
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("focus", () => { const b = el.getBoundingClientRect(); showTip({ clientX: b.right, clientY: b.top }, r); });
    el.addEventListener("blur", hideTip);
  });
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function renderBars(rows) {
  const el = $("barChart");
  const turnoverMode = noCostsInView(rows);
  const metric = turnoverMode ? "turnover" : "dailyPool";
  $("barTitle").textContent = turnoverMode ? "Turnover per day, whole market" : "Expected daily profit, whole market";
  $("barNote").textContent = turnoverMode
    ? "Sell price after fees × units sold per day. Crafting cost isn't known for these tiers yet, so this is market size, not profit."
    : "Profit per craft × units sold per day. This is the pool every crafter on the server is competing for.";
  const data = rows.filter((r) => r[metric] != null && r[metric] > 0).sort((a, b) => b[metric] - a[metric]).slice(0, 10);
  if (!data.length) {
    el.innerHTML = `<svg viewBox="0 0 560 120"><text class="empty" x="280" y="64" text-anchor="middle">${turnoverMode ? "No sales estimates for these items yet." : "No craft is both profitable and selling with these settings."}</text></svg>`;
    return;
  }
  const W = 640, rowH = 30, left = 250, right = 64, top = 6, bottom = 26; // left fits full item names
  const H = top + data.length * rowH + bottom;
  const ticks = niceTicks(Math.max(...data.map((d) => d[metric])));
  const max = ticks[ticks.length - 1];
  const x = (v) => left + (v / max) * (W - left - right);
  const barH = 16;
  const bar = (x0, y0, w) => {
    const r = Math.min(4, w / 2);
    return `M${x0},${y0}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${barH - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
  };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${turnoverMode ? "Turnover per day" : "Expected daily profit"} by craft">
    <g class="grid">${ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - bottom}"/>`).join("")}</g>
    ${ticks.map((t) => `<text class="axis-label" x="${x(t)}" y="${H - 8}" text-anchor="middle">${kinah(t)}</text>`).join("")}
    ${data.map((d, i) => {
      const y = top + i * rowH + (rowH - barH) / 2;
      const w = Math.max(2, x(d[metric]) - left);
      return `<g class="row">
        <text x="${left - 10}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(d.shortName)}</text>
        <path class="bar" d="${bar(left, y, w)}"/>
        <text class="value-label" x="${left + w + 6}" y="${y + barH / 2 + 4}">${kinah(d[metric])}</text>
        <rect class="hit" data-i="${i}" tabindex="0" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>
      </g>`;
    }).join("")}
  </svg>`;
  wireTips(el, data);
}

function renderScatter(rows, settings) {
  const el = $("scatter");
  // Items with zero sales would sit on the x-axis and stretch it; the table still lists them.
  const data = rows.filter((r) => r.marginPct != null && r.perDay != null && r.perDay > 0);
  if (!data.length) {
    el.innerHTML = `<svg viewBox="0 0 560 120"><text class="empty" x="280" y="64" text-anchor="middle">${rows.length && rows.every((r) => r.cost == null) ? "Margins need a crafting cost, which these tiers don't have yet." : "Not enough listing history yet to estimate sales."}</text></svg>`;
    return;
  }
  const W = 560, H = 330, left = 46, right = 16, top = 12, bottom = 40;
  const mins = Math.min(-10, ...data.map((d) => d.marginPct));
  const maxs = Math.max(10, ...data.map((d) => d.marginPct));
  const span = maxs - mins;
  const x0 = mins - span * 0.05, x1 = maxs + span * 0.05;
  const yTicks = niceTicks(Math.max(settings.minSalesPerDay * 2, ...data.map((d) => d.perDay)));
  const y1 = yTicks[yTicks.length - 1];
  const x = (v) => left + ((v - x0) / (x1 - x0)) * (W - left - right);
  const y = (v) => top + (1 - v / y1) * (H - top - bottom);
  const xTicks = (() => {
    const step = niceTicks(x1 - x0, 5)[1] || 10;
    const out = [];
    for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) out.push(+v.toFixed(6));
    return out;
  })();
  const labelled = new Set([...data].sort(byRank).slice(0, 5).map((d) => d.key));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Margin versus units sold per day">
    <g class="grid">
      ${yTicks.map((t) => `<line x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}
    </g>
    ${yTicks.map((t) => `<text class="axis-label" x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${rate(t)}</text>`).join("")}
    ${xTicks.map((t) => `<text class="axis-label" x="${x(t)}" y="${H - bottom + 18}" text-anchor="middle">${t}%</text>`).join("")}
    <line class="ref" x1="${x(0)}" x2="${x(0)}" y1="${top}" y2="${H - bottom}"/>
    <line class="ref" x1="${left}" x2="${W - right}" y1="${y(settings.minSalesPerDay)}" y2="${y(settings.minSalesPerDay)}"/>
    <text class="axis-label" x="${W - right}" y="${H - 6}" text-anchor="end">Margin →</text>
    <text class="axis-label" x="${left}" y="${top - 2}" text-anchor="start" dy="-2">Sold / day ↑</text>
    ${data.map((d, i) => {
      const good = d.verdict.id === "craft";
      return `<circle class="dot${good ? "" : " dim"}" cx="${x(d.marginPct)}" cy="${y(d.perDay)}" r="${good ? 6 : 5}"/>
        <circle class="hit" data-i="${i}" tabindex="0" cx="${x(d.marginPct)}" cy="${y(d.perDay)}" r="13"/>`;
    }).join("")}
    ${placeLabels(data.filter((d) => labelled.has(d.key)).map((d) => {
      const cx = x(d.marginPct), labelW = d.shortName.length * 6.3; // ~6.3px per character at 11.5px
      const anchor = cx + 10 + labelW > W - right ? "end" : "start";
      return { cx, cy: y(d.perDay), anchor, text: d.shortName };
    }), top + 8, H - bottom - 4).map((l) => {
      const tx = l.cx + (l.anchor === "end" ? -10 : 10);
      const leader = Math.abs(l.ly - l.cy) > 6 ? `<line class="ref" style="stroke-dasharray:none;opacity:.5" x1="${l.cx}" y1="${l.cy}" x2="${tx - (l.anchor === "end" ? -2 : 2)}" y2="${l.ly}"/>` : "";
      return `${leader}<text x="${tx}" y="${l.ly + 4}" text-anchor="${l.anchor}">${esc(l.text)}</text>`;
    }).join("")}
  </svg>`;
  wireTips(el, data);
}

// Spread point labels vertically so none overlap.
function placeLabels(labels, minY, maxY, gap = 14) {
  {
    const group = [...labels].sort((a, b) => a.cy - b.cy);
    group.forEach((l, i) => (l.ly = Math.max(l.cy, i ? group[i - 1].ly + gap : minY)));
    for (let i = group.length - 1; i >= 0; i--) {
      const limit = i === group.length - 1 ? maxY : group[i + 1].ly - gap;
      if (group[i].ly > limit) group[i].ly = limit;
    }
  }
  return labels;
}

// Item icon from aion2.exchange's icon set, framed in the item's rarity color. Cosmetic: hidden if it fails to load.
function iconHtml(key, size = "") {
  const ic = state.market?.icons?.[key];
  if (!ic) return "";
  const [file, color, rarity] = ic;
  const style = /^#[0-9a-f]{6}$/i.test(color || "") ? ` style="--rarity:${color}"` : "";
  return `<img class="item-icon ${size}" src="${API}/item-icons/${encodeURIComponent(file)}.webp" alt=""${style} title="${esc(rarity || "")}" loading="lazy" decoding="async" onerror="this.remove()">`;
}

// ---------- recipe breakdown (expanded row) ----------
function itemUrl(key, tier) {
  // Artisan's Splendent items have a cost-breakdown page; everything else has an item page.
  return `${API}/${tier === "Artisan's Splendent" ? "crafts" : "items"}/${key}`;
}

function extLink(r, style = "button") {
  const url = itemUrl(r.key, r.tier);
  const label = r.tier === "Artisan's Splendent" ? "crafting page" : "item page";
  return style === "icon"
    ? `<a class="ext-link" href="${url}" target="_blank" rel="noopener" title="Open the ${label} on aion2.exchange" aria-label="Open ${esc(r.shortName)} on aion2.exchange">↗</a>`
    : `<a class="ext-button" href="${url}" target="_blank" rel="noopener">Open ${label} on aion2.exchange ↗</a>`;
}

const matLink = (key, name) => `<a href="${API}/items/${key}" target="_blank" rel="noopener" title="Open on aion2.exchange">${esc(name)}</a>`;
const METHOD = { buy: "Bought", convert: "Converted", morph: "Converted", craft: "Crafted" };
function methodLabel(m) {
  const base = METHOD[m.method] || (m.method ? String(m.method) : "—");
  const via = (Array.isArray(m.via) ? m.via : [])
    .map((v) => (typeof v === "string" ? v : v?.name || v?.material_name || ""))
    .filter(Boolean);
  return via.length ? `${base} via ${esc(via.join(", "))}` : base;
}

// ---------- recipes, laid out the way the game (and questlog.gg) shows them ----------
// Each Artisan's Splendent item has aion2.exchange's cost chain: step 1 makes the Splendent item, step 2 the
// Expert's Splendent (consuming 1 Splendent per attempt), step 3 the Artisan's Splendent (consuming 1 Expert's).
function chainOf(key) {
  const chains = state.market?.chains || {};
  for (const [k, c] of Object.entries(chains)) {
    const i = (c.steps || []).findIndex((s) => s.result_key === key);
    if (i >= 0) return { chain: c, index: i };
  }
  return null;
}

const tierOf = (chain, key) => (chain.tiers || []).find((x) => x.item_key === key) || {};
const asPct = (v) => `${(v * 100).toFixed(Math.abs(v * 100 - Math.round(v * 100)) > 0.05 ? 1 : 0)}%`; // 25%, 96.8%

function priceCells({ market, crafted, used }) {
  return `<td class="${used === "market" ? "used" : ""}">${kinah(market)}</td>` +
    `<td class="${used === "crafted" ? "used" : ""}">${crafted == null ? "—" : kinah(crafted)}</td>`;
}

function recipeTable(rows, perAttempt) {
  return `<table class="recipe"><thead><tr><th>Input</th><th>Qty</th><th>Market price</th><th>Crafted price</th><th>Used</th><th>Cost</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody><tfoot><tr><td colspan="5">Per craft attempt</td><td>${kinah(perAttempt)}</td></tr></tfoot></table>`;
}

// One card: the recipe that makes `steps[index]`'s result, with a nested card for the gear it consumes.
function stepCard(chain, index, depth = 0) {
  const s = chain.steps[index];
  const prevStep = index > 0 ? chain.steps[index - 1] : null;
  const prev = prevStep ? tierOf(chain, prevStep.result_key) : null;
  const rows = [];
  let perAttempt = 0;
  if (prevStep) {
    perAttempt += prev.cost ?? 0;
    rows.push(`<tr><td>${matLink(prevStep.result_key, prevStep.result_name)}</td><td>1</td>` +
      priceCells({ market: prev.market_price, crafted: prev.cost, used: "crafted" }) +
      `<td>Crafted <span class="muted">(below)</span></td><td>${kinah(prev.cost)}</td></tr>`);
  }
  for (const m of s.materials || []) {
    const cost = (m.unit_price ?? 0) * m.per_attempt;
    perAttempt += cost;
    const bought = !m.method || m.method === "buy";
    rows.push(`<tr><td>${matLink(m.material_key, m.name)}</td><td>${m.per_attempt}</td>` +
      priceCells({ market: m.listing_price, crafted: bought ? null : m.unit_price, used: bought ? "market" : "crafted" }) +
      `<td>${methodLabel(m)}</td><td>${kinah(cost)}</td></tr>`);
  }
  const rate = (s.success_rate ?? 1) * (s.combo_probability ?? 1);
  const itemCost = tierOf(chain, s.result_key).cost ?? perAttempt / rate;
  const sum = `<p class="detail-sum">A craft succeeds ${asPct(s.success_rate ?? 1)} of the time and only the ` +
    `${asPct(s.combo_probability ?? 1)} combo makes <strong>${esc(s.result_name)}</strong>, so one costs ` +
    `${kinah(perAttempt)} ÷ (${asPct(s.success_rate ?? 1)} × ${asPct(s.combo_probability ?? 1)}) = <strong>${kinah(itemCost)}</strong>` +
    ` (about ${(1 / rate).toFixed(1)} attempts each).</p>`;
  const sub = prevStep
    ? `<details class="sub"${depth < 1 ? " open" : ""}><summary>How ${esc(prevStep.result_name)} is made</summary>${stepCard(chain, index - 1, depth + 1)}</details>`
    : "";
  return `<div class="recipe-card">${recipeTable(rows, perAttempt)}${sum}${sub}</div>`;
}

function detailHtml(r) {
  const head = `<div class="detail-head"><div><h3>How ${esc(r.shortName)} is made</h3>` +
    `<p class="muted">${esc(r.skill)} · cost per item ${kinah(r.cost)}${r.listing != null ? ` · cheapest listing ${kinah(r.listing)}` : ""}</p></div>${extLink(r)}</div>`;
  const note = `<p class="muted small">Highlighted price is the one used. Gear inputs use their crafted cost; materials use the cheapest way to get them ` +
    `(bought at the cheapest listing, or converted/crafted when that's cheaper). Click a "How … is made" line to open or close a sub-recipe. ` +
    `Recipes from questlog.gg; Splendent costs from aion2.exchange's model.</p>`;
  if (r.costDetail) return head + trueDragonCard(r) + note;
  const c = chainOf(r.key);
  if (c) return head + stepCard(c.chain, c.index) + note;
  return head + `<p class="muted">No recipe available for this item.</p>`;
}

function trueDragonCard(r) {
  const d = r.costDetail;
  const rows = [`<tr><td>${matLink(d.baseKey, d.baseName)}</td><td>1</td>` +
    priceCells({ market: d.baseListing, crafted: d.baseCraft, used: d.baseMethod === "craft" ? "crafted" : "market" }) +
    `<td>${d.baseMethod === "craft" ? "Crafted <span class=\"muted\">(below)</span>" : "Bought"}</td><td>${kinah(d.base)}</td></tr>`];
  for (const m of d.materials) {
    rows.push(`<tr><td>${matLink(m.key, m.name)}</td><td>${m.qty}</td>` + priceCells({ market: m.price, crafted: null, used: "market" }) +
      `<td>Bought</td><td>${m.price == null ? "—" : kinah(m.price * m.qty)}</td></tr>`);
  }
  const combo = Math.round(d.comboProbability * 100);
  const sum = d.factor !== 1
    ? `<p class="detail-sum">This item only comes from the ${combo}% combo on the True Dragon craft, so it costs ${kinah(d.attempt)} × ${+d.factor.toFixed(2)} = <strong>${kinah(r.cost)}</strong>.</p>`
    : `<p class="detail-sum">Every attempt makes a True Dragon item, so it costs one attempt: <strong>${kinah(d.attempt)}</strong>. ${combo}% of attempts make the Splendent version instead.</p>`;
  const base = chainOf(d.baseKey);
  const sub = base
    ? `<details class="sub" open><summary>How ${esc(d.baseName)} is made</summary>${stepCard(base.chain, base.index, 1)}</details>`
    : "";
  return `<div class="recipe-card">${recipeTable(rows, d.attempt)}${sum}${sub}</div>`;
}

function costTitle(r) {
  const d = r.costDetail;
  if (!d) return r.cost == null ? "No crafting cost known" : "aion2.exchange crafting model: expected cost per item at mastery 100, cheapest path";
  const base = `${d.baseName} ${kinah(d.base)} (${d.baseMethod === "craft" ? "crafted" : "bought"}; craft ${kinah(d.baseCraft)}, listing ${kinah(d.baseListing)})`;
  const mats = d.materials.map((m) => `${m.qty}× ${m.name} @ ${kinah(m.price)}`).join(", ");
  const per = `= ${kinah(d.attempt)} per craft attempt`;
  const combo = d.factor !== 1 ? `; ÷ ${Math.round(d.comboProbability * 100)}% combo chance = ${kinah(r.cost)}` : "";
  return `${base} + materials ${kinah(d.matsCost)} (${mats}) ${per}${combo}`;
}

function capitalTitle(r) {
  if (r.capital == null) return "Needs a crafting cost";
  const n = r.attempts90;
  if (n == null || n <= 1 || r.hitChance == null || r.hitChance >= 1)
    return `Every attempt makes one, so the capital needed is one attempt: ${kinah(r.capital)}. Return on capital = profit ÷ that.`;
  return `Each attempt makes this only ${(r.hitChance * 100).toFixed(1)}% of the time (success × combo), so on average it takes ` +
    `${(1 / r.hitChance).toFixed(1)} attempts (${kinah(r.cost)}), but you need ${n} attempts' worth (${kinah(r.capital)}) ` +
    `for a 90% chance of making one. Return on capital = profit ÷ that.`;
}

function salesTitle(r) {
  if (r.salesSource === "official") return `${r.sold28} sold in 28 days (official game statistics)`;
  const e = r.est;
  if (!e) return "No listing history";
  if (e.perDay == null) return `Only ${e.days.toFixed(1)} days of listing history; need ${ESTIMATOR.minDays}+`;
  return `Estimated from listing history: ${e.sales} sales seen over ${e.days.toFixed(1)} days ` +
    `(${rate(e.observedPerDay)}/day), × ${ESTIMATOR.captureAdjust} for sales between hourly snapshots. ` +
    `At least ${rate(e.lowerPerDay)}/day where the cheapest listing clearly sold.`;
}

const COLUMNS = [
  { key: "rank", label: "#", cls: "rank", sortVal: (r) => -r.rank, fmt: (r) => (r.cost == null ? "—" : r.rank) },
  { key: "name", label: "Craft", cls: "name", sortVal: (r) => r.shortName,
    fmt: (r) => {
      const tier = r.tier === "Artisan's Splendent" ? "" : `${esc(r.tier)} · `;
      const open = state.ui.open === r.key;
      return `<span class="item-cell">${iconHtml(r.key)}<span class="item-text">` +
        `<button type="button" class="item-toggle" data-toggle="${r.key}" aria-expanded="${open}" title="Show the recipe and what goes into the cost">` +
        `<span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span>${esc(r.shortName)}</button>` +
        `<span class="meta">${tier}${esc(r.skill)} · ${esc(r.category)}</span></span>${extLink(r, "icon")}</span>`;
    } },
  { key: "verdict", label: "Verdict", sortVal: (r) => VERDICT_ORDER[r.verdict.id],
    fmt: (r) => `<span class="pill ${r.verdict.tone}">${esc(r.verdict.label)}</span>` },
  { key: "cost", label: "Cost", fmt: (r) => (r.costDetail ? "≈" : "") + kinah(r.cost), title: costTitle },
  { key: "price", label: "Sell price", fmt: (r) => kinah(r.price),
    title: (r) => `Cheapest listing ${kinah(r.listing)} · avg sale ${kinah(r.soldAvg)}${r.priceSource === "estimate" ? " (estimated from listings that sold)" : r.priceSource === "official" ? " (28-day official)" : ""}` },
  { key: "profit", label: "Profit / craft", fmt: (r) => kinah(r.profit, { sign: true }), tone: (r) => (r.profit == null ? "dim" : r.profit > 0 ? "pos" : "neg") },
  { key: "marginPct", label: "Margin", fmt: (r) => pct(r.marginPct), title: () => "Profit ÷ average cost per item", tone: (r) => (r.marginPct == null ? "dim" : r.marginPct > 0 ? "pos" : "neg") },
  { key: "capital", label: "Capital needed", fmt: (r) => kinah(r.capital), title: capitalTitle },
  { key: "roc", label: "Return on capital", fmt: (r) => pct(r.roc), title: capitalTitle,
    tone: (r) => (r.roc == null ? "dim" : r.roc > 0 ? "pos" : "neg") },
  { key: "perDay", label: "Sold / day", fmt: (r) => (r.salesSource === "estimate" ? "~" : "") + rate(r.perDay), title: salesTitle },
  { key: "listings", label: "Listings", fmt: (r) => r.listings },
  { key: "supplyDays", label: "Days supply", fmt: (r) => days(r.supplyDays) },
  { key: "dailyPool", label: "Daily pool", fmt: (r) => kinah(r.dailyPool, { sign: true }), tone: (r) => (r.dailyPool == null ? "dim" : r.dailyPool < 0 ? "neg" : "") },
  { key: "turnover", label: "Turnover / day", fmt: (r) => kinah(r.turnover), tone: (r) => (r.turnover == null ? "dim" : ""),
    title: () => "Sell price after fees × sold per day: the size of the market, before crafting cost" },
  { key: "yourDaily", label: "Your daily", fmt: (r) => kinah(r.yourDaily, { sign: true }), tone: (r) => (r.yourDaily == null ? "dim" : r.yourDaily < 0 ? "neg" : "") },
];

function renderTable(rows) {
  const { sort, dir } = state.ui;
  const col = COLUMNS.find((c) => c.key === sort) || COLUMNS[0];
  const val = col.sortVal || ((r) => r[col.key]);
  const sorted = [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return dir === "asc" ? c : -c;
  });

  const thead = $("table").tHead;
  thead.innerHTML = `<tr>${COLUMNS.map((c) => {
    const active = c.key === sort;
    const ariaSort = active ? (dir === "asc" ? "ascending" : "descending") : null;
    return `<th${ariaSort ? ` aria-sort="${ariaSort}"` : ""}><button type="button" data-k="${c.key}">${c.label}</button></th>`;
  }).join("")}</tr>`;
  thead.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const k = b.dataset.k;
    if (state.ui.sort === k) state.ui.dir = state.ui.dir === "desc" ? "asc" : "desc";
    else { state.ui.sort = k; state.ui.dir = k === "name" ? "asc" : "desc"; }
    writeUrl(); renderTable(state.rows);
  };

  const topKey = rows.find((r) => r.verdict.id === "craft")?.key;
  const body = $("table").tBodies[0];
  body.innerHTML = sorted.map((r) => {
    const open = state.ui.open === r.key;
    const cls = [r.key === topKey ? "top-pick" : "", "item-row", open ? "open" : ""].filter(Boolean).join(" ");
    const cells = COLUMNS.map((c) => {
      const tone = c.tone ? c.tone(r) : "";
      const title = c.title ? ` title="${esc(c.title(r))}"` : "";
      return `<td class="${[c.cls, tone].filter(Boolean).join(" ")}"${title}>${c.fmt(r)}</td>`;
    }).join("");
    const detail = open ? `<tr class="detail-row"><td colspan="${COLUMNS.length}"><div class="detail-inner">${detailHtml(r)}</div></td></tr>` : "";
    return `<tr class="${cls}" data-key="${r.key}">${cells}</tr>${detail}`;
  }).join("") || `<tr><td colspan="${COLUMNS.length}" class="dim">No crafts match these filters.</td></tr>`;
  // Clicking an item row (anywhere but a link) expands its recipe; clicking it again closes it.
  body.onclick = (e) => {
    if (e.target.closest("a, .detail-row")) return;
    const tr = e.target.closest("tr.item-row");
    if (!tr) return;
    const key = +tr.dataset.key;
    state.ui.open = state.ui.open === key ? null : key;
    writeUrl();
    renderTable(state.rows);
    if (state.ui.open != null) body.querySelector(`[data-toggle="${key}"]`)?.focus({ preventScroll: true });
  };

  const basis = { conservative: "lower of cheapest listing and average sale price", listing: "cheapest current listing", sold: "average sale price" }[state.ui.priceBasis];
  $("tableNote").textContent = `${rows.length} crafts · ~ = estimated from listing history · sell price = ${basis}${state.ui.salesTaxPct + state.ui.listingFeePct ? `, minus ${state.ui.salesTaxPct}% tax and ${state.ui.listingFeePct}% listing fee` : ""}`;
}

init();
