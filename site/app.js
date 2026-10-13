import { analyzeMarket, DEFAULT_SETTINGS, ESTIMATOR, byRank } from "./metrics.js";

const API = "https://aion2.exchange";
const SNAPSHOT_URL = "data/snapshot.json";
const SERVER_ID = 11201; // the dashboard covers Siel · Elyos, North America West only
const HISTORY_DAYS = 10;
const SKILLS = ["All", "Blacksmithing", "Tailoring", "Jewelcrafting", "Alchemy"];

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
const rate = (v) => (v == null ? "—" : v >= 10 ? v.toFixed(0) : v.toFixed(1));
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
    priceBasis: ["conservative", "listing", "sold"].includes(p.get("price")) ? p.get("price") : DEFAULT_SETTINGS.priceBasis,
    costBasis: ["cheapest", "market"].includes(p.get("cost")) ? p.get("cost") : DEFAULT_SETTINGS.costBasis,
    salesTaxPct: Math.min(50, Math.max(0, n("tax", DEFAULT_SETTINGS.salesTaxPct))),
    listingFeePct: Math.min(50, Math.max(0, n("listfee", DEFAULT_SETTINGS.listingFeePct))),
    sharePct: Math.min(100, Math.max(1, n("share", DEFAULT_SETTINGS.sharePct))),
    hideLoss: p.get("hideLoss") === "1",
    sort: p.get("sort") || "rank",
    dir: p.get("dir") === "asc" ? "asc" : "desc",
  };
}
function writeUrl() {
  const u = state.ui;
  const p = new URLSearchParams();
  if (u.skill !== "All") p.set("skill", u.skill);
  if (u.priceBasis !== DEFAULT_SETTINGS.priceBasis) p.set("price", u.priceBasis);
  if (u.costBasis !== DEFAULT_SETTINGS.costBasis) p.set("cost", u.costBasis);
  if (u.salesTaxPct !== DEFAULT_SETTINGS.salesTaxPct) p.set("tax", u.salesTaxPct);
  if (u.listingFeePct !== DEFAULT_SETTINGS.listingFeePct) p.set("listfee", u.listingFeePct);
  if (u.sharePct !== DEFAULT_SETTINGS.sharePct) p.set("share", u.sharePct);
  if (u.hideLoss) p.set("hideLoss", "1");
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
      state.market = { captured_at: crafts.captured_at, targets: crafts.targets, items: items.items, history };
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
  if (state.ui.skill !== "All") rows = rows.filter((r) => r.skill === state.ui.skill);
  if (state.ui.hideLoss) rows = rows.filter((r) => !(r.profit != null && r.profit <= 0));
  state.rows = rows;
  renderKpis(rows);
  renderBars(rows);
  renderScatter(rows, settings);
  renderTable(rows);
}

function renderKpis(rows) {
  const good = rows.filter((r) => r.verdict.id === "craft");
  const best = [...rows].sort(byRank)[0];
  const pool = rows.reduce((s, r) => s + Math.max(0, r.dailyPool ?? 0), 0);
  const margins = rows.map((r) => r.marginPct).filter((v) => v != null).sort((a, b) => a - b);
  const median = margins.length ? margins[Math.floor(margins.length / 2)] : null;
  const yours = best?.yourDaily;
  const tiles = [
    { label: "Best craft right now", value: best && best.dailyPool > 0 ? best.shortName : "Nothing profitable", sub: best && best.dailyPool > 0 ? `${kinah(best.profit)} per craft · ${rate(best.perDay)}/day sold` : "Try another price basis" },
    { label: "Your expected daily profit", value: yours > 0 ? kinah(yours) : "—", sub: yours > 0 ? `from ${best.shortName} at ${state.ui.sharePct}% share` : "No craft with positive profit and sales" },
    { label: "Worth crafting", value: `${good.length} of ${rows.length}`, sub: "profitable, selling, not oversupplied" },
    { label: "Median margin", value: pct(median), sub: `market-wide daily pool ${kinah(pool)}` },
  ];
  $("kpis").innerHTML = tiles.map((t) => `<div class="kpi"><div class="label">${esc(t.label)}</div><div class="value" title="${esc(t.value)}">${esc(t.value)}</div><div class="sub" title="${esc(t.sub)}">${esc(t.sub)}</div></div>`).join("");
}

// ----- tooltip -----
const tip = $("tooltip");
function showTip(e, r) {
  tip.innerHTML = `<strong>${esc(r.shortName)}</strong>
    <div class="row"><span>Profit / craft</span><span>${kinah(r.profit, { sign: true })}</span></div>
    <div class="row"><span>Margin</span><span>${pct(r.marginPct)}</span></div>
    <div class="row"><span>Sold / day${r.salesSource === "estimate" ? " (est.)" : ""}</span><span>${rate(r.perDay)}</span></div>
    <div class="row"><span>Listings</span><span>${r.listings}</span></div>
    <div class="row"><span>Daily pool</span><span>${kinah(r.dailyPool)}</span></div>
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
  const data = rows.filter((r) => r.dailyPool != null && r.dailyPool > 0).slice(0, 10);
  if (!data.length) {
    el.innerHTML = `<svg viewBox="0 0 560 120"><text class="empty" x="280" y="64" text-anchor="middle">No craft is both profitable and selling with these settings.</text></svg>`;
    return;
  }
  const W = 560, rowH = 30, left = 150, right = 64, top = 6, bottom = 26;
  const H = top + data.length * rowH + bottom;
  const ticks = niceTicks(Math.max(...data.map((d) => d.dailyPool)));
  const max = ticks[ticks.length - 1];
  const x = (v) => left + (v / max) * (W - left - right);
  const barH = 16;
  const bar = (x0, y0, w) => {
    const r = Math.min(4, w / 2);
    return `M${x0},${y0}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${barH - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
  };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Expected daily profit by craft">
    <g class="grid">${ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - bottom}"/>`).join("")}</g>
    ${ticks.map((t) => `<text class="axis-label" x="${x(t)}" y="${H - 8}" text-anchor="middle">${kinah(t)}</text>`).join("")}
    ${data.map((d, i) => {
      const y = top + i * rowH + (rowH - barH) / 2;
      const w = Math.max(2, x(d.dailyPool) - left);
      return `<g class="row">
        <text x="${left - 10}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(d.shortName)}</text>
        <path class="bar" d="${bar(left, y, w)}"/>
        <text class="value-label" x="${left + w + 6}" y="${y + barH / 2 + 4}">${kinah(d.dailyPool)}</text>
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
    el.innerHTML = `<svg viewBox="0 0 560 120"><text class="empty" x="280" y="64" text-anchor="middle">Not enough listing history yet to estimate sales.</text></svg>`;
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
      const cx = x(d.marginPct), anchor = cx > W - 140 ? "end" : "start";
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
  { key: "rank", label: "#", cls: "rank", sortVal: (r) => -r.rank, fmt: (r) => r.rank },
  { key: "name", label: "Craft", cls: "name", sortVal: (r) => r.shortName,
    fmt: (r) => `<a href="${API}/items/${r.key}" target="_blank" rel="noopener">${esc(r.shortName)}</a><span class="meta">${esc(r.skill)} · ${esc(r.category)}</span>` },
  { key: "verdict", label: "Verdict", sortVal: (r) => ({ craft: 0, glut: 1, thin: 2, nosales: 3, incomplete: 4, loss: 5, nodata: 6 })[r.verdict.id],
    fmt: (r) => `<span class="pill ${r.verdict.tone}">${esc(r.verdict.label)}</span>` },
  { key: "cost", label: "Cost", fmt: (r) => kinah(r.cost) },
  { key: "price", label: "Sell price", fmt: (r) => kinah(r.price),
    title: (r) => `Cheapest listing ${kinah(r.listing)} · avg sale ${kinah(r.soldAvg)}${r.priceSource === "estimate" ? " (estimated from listings that sold)" : r.priceSource === "official" ? " (28-day official)" : ""}` },
  { key: "profit", label: "Profit / craft", fmt: (r) => kinah(r.profit, { sign: true }), tone: (r) => (r.profit == null ? "dim" : r.profit > 0 ? "pos" : "neg") },
  { key: "marginPct", label: "Margin", fmt: (r) => pct(r.marginPct), tone: (r) => (r.marginPct == null ? "dim" : r.marginPct > 0 ? "pos" : "neg") },
  { key: "perDay", label: "Sold / day", fmt: (r) => (r.salesSource === "estimate" ? "~" : "") + rate(r.perDay), title: salesTitle },
  { key: "listings", label: "Listings", fmt: (r) => r.listings },
  { key: "supplyDays", label: "Days supply", fmt: (r) => days(r.supplyDays) },
  { key: "dailyPool", label: "Daily pool", fmt: (r) => kinah(r.dailyPool, { sign: true }), tone: (r) => (r.dailyPool == null ? "dim" : r.dailyPool < 0 ? "neg" : "") },
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
  $("table").tBodies[0].innerHTML = sorted.map((r) => `<tr class="${r.key === topKey ? "top-pick" : ""}">${COLUMNS.map((c) => {
    const tone = c.tone ? c.tone(r) : "";
    const title = c.title ? ` title="${esc(c.title(r))}"` : "";
    return `<td class="${[c.cls, tone].filter(Boolean).join(" ")}"${title}>${c.fmt(r)}</td>`;
  }).join("")}</tr>`).join("") || `<tr><td colspan="${COLUMNS.length}" class="dim">No crafts match these filters.</td></tr>`;

  const basis = { conservative: "lower of cheapest listing and average sale price", listing: "cheapest current listing", sold: "average sale price" }[state.ui.priceBasis];
  $("tableNote").textContent = `${rows.length} crafts · ~ = estimated from listing history · sell price = ${basis}${state.ui.salesTaxPct + state.ui.listingFeePct ? `, minus ${state.ui.salesTaxPct}% tax and ${state.ui.listingFeePct}% listing fee` : ""}`;
}

init();
