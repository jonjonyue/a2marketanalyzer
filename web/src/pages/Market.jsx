import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeMarket, DEFAULT_SETTINGS, ESTIMATOR, VERDICT_ORDER, byRank, isWorthCrafting, SKILLS as CRAFT_SKILLS, masteryLabel, shortenName, parseKinah } from "../lib/metrics.js";
import { kinah, pct, rate, days, ago, asPct, cx } from "../lib/format.js";
import { KEYS, readJson, readRaw, writeRaw, useKinah, useStoredRaw } from "../lib/storage.js";
import { entriesOf } from "../lib/ledgerStore.js";
import { DEFAULT_SERVER, serverLabel, useServerDoc, useSnapshot } from "../lib/data.js";
import { ItemIcon } from "../components/ItemIcon.jsx";
import { planView } from "../components/Plan.jsx";
import { BarChart, Scatter, Tooltip, noCostsInView, useTip } from "../components/Charts.jsx";
import { ExtLink, RecipeDetail } from "../components/Recipe.jsx";
import { MarketMethod } from "./MarketMethod.jsx";

const REGION_SHORT = { NAE: "NA East", NAW: "NA West", EU: "EU", LA: "SA", AS: "Asia" };
const SKILLS = ["All", "Blacksmithing", "Armorsmithing", "Handicrafting", "Alchemy"];
// URL codes per skill; t and j are the old Tailoring / Jewelcrafting codes, kept so older links still work.
const PROF_CODE = { Blacksmithing: "b", Armorsmithing: "r", Handicrafting: "h", Alchemy: "a" };
const PROF_LEGACY = { t: "Armorsmithing", j: "Handicrafting" };
const TIERS = ["All", "Expert's Splendent", "Artisan's Splendent", "True Dragon", "Splendent True Dragon"];
const TIER_PARAM = { "Expert's Splendent": "es", "Artisan's Splendent": "as", "True Dragon": "td", "Splendent True Dragon": "std" };

// ---------- URL state (so a copied link reproduces the view) ----------
function savedServer() {
  const v = parseInt(readRaw(KEYS.server), 10);
  return Number.isInteger(v) ? v : DEFAULT_SERVER;
}
function savedProficiency() {
  const out = { ...DEFAULT_SETTINGS.proficiency };
  const saved = readJson(KEYS.proficiency) || {};
  for (const k of CRAFT_SKILLS) if (Number.isInteger(saved[k]) && saved[k] >= 1 && saved[k] <= 100) out[k] = saved[k];
  return out;
}
// "b60.r75" -> { Blacksmithing: 60, Armorsmithing: 75, ... } (others default)
function readProficiency(v) {
  const out = { ...DEFAULT_SETTINGS.proficiency };
  for (const part of String(v || "").split(".")) {
    const skill = CRAFT_SKILLS.find((k) => PROF_CODE[k] === part[0]) || PROF_LEGACY[part[0]];
    const lvl = parseInt(part.slice(1), 10);
    if (skill && lvl >= 1 && lvl <= 100) out[skill] = lvl;
  }
  return out;
}
function readUrl() {
  const p = new URLSearchParams(location.search);
  const n = (k, d) => (p.has(k) && Number.isFinite(+p.get(k)) ? +p.get(k) : d);
  return {
    // A link's server wins; otherwise the server this browser used last. Checked against the server list once it loads.
    server: p.has("server") && Number.isInteger(+p.get("server")) ? +p.get("server") : savedServer(),
    skill: SKILLS.includes(p.get("skill")) ? p.get("skill") : "All",
    tier: Object.keys(TIER_PARAM).find((k) => TIER_PARAM[k] === p.get("tier")) || "All",
    priceBasis: ["conservative", "listing", "sold"].includes(p.get("price")) ? p.get("price") : DEFAULT_SETTINGS.priceBasis,
    costBasis: ["cheapest", "market"].includes(p.get("cost")) ? p.get("cost") : DEFAULT_SETTINGS.costBasis,
    salesTaxPct: Math.min(50, Math.max(0, n("tax", DEFAULT_SETTINGS.salesTaxPct))),
    listingFeePct: Math.min(50, Math.max(0, n("listfee", DEFAULT_SETTINGS.listingFeePct))),
    sharePct: Math.min(100, Math.max(1, n("share", DEFAULT_SETTINGS.sharePct))),
    hideLoss: p.get("hideLoss") === "1",
    open: p.has("open") ? +p.get("open") : null,
    // A shared link's levels win (to reproduce that view); otherwise the levels this browser saved last time.
    proficiency: p.has("prof") ? readProficiency(p.get("prof")) : savedProficiency(),
    sort: p.get("sort") || "rank",
    dir: p.get("dir") === "asc" ? "asc" : "desc",
  };
}
function writeUrl(u) {
  const p = new URLSearchParams();
  if (u.server !== DEFAULT_SERVER) p.set("server", u.server);
  if (u.skill !== "All") p.set("skill", u.skill);
  if (u.tier !== "All") p.set("tier", TIER_PARAM[u.tier]);
  if (u.priceBasis !== DEFAULT_SETTINGS.priceBasis) p.set("price", u.priceBasis);
  if (u.costBasis !== DEFAULT_SETTINGS.costBasis) p.set("cost", u.costBasis);
  if (u.salesTaxPct !== DEFAULT_SETTINGS.salesTaxPct) p.set("tax", u.salesTaxPct);
  if (u.listingFeePct !== DEFAULT_SETTINGS.listingFeePct) p.set("listfee", u.listingFeePct);
  if (u.sharePct !== DEFAULT_SETTINGS.sharePct) p.set("share", u.sharePct);
  if (u.hideLoss) p.set("hideLoss", "1");
  if (u.open != null) p.set("open", u.open);
  const prof = CRAFT_SKILLS.filter((k) => u.proficiency[k] !== DEFAULT_SETTINGS.proficiency[k])
    .map((k) => PROF_CODE[k] + u.proficiency[k]).join(".");
  if (prof) p.set("prof", prof);
  if (u.sort !== "rank") { p.set("sort", u.sort); p.set("dir", u.dir); }
  const qs = p.toString();
  history.replaceState(null, "", (qs ? `?${qs}` : location.pathname) + location.hash);
}

// ---------- controls ----------
function BudgetInput({ budget }) {
  const ref = useRef(null);
  const show = (v) => (v ? Math.round(v).toLocaleString("en-US") : "");
  const [text, setText] = useState(show(budget));
  const [invalid, setInvalid] = useState(false);
  // The Profit Calculator moves your kinah with each entry; pick up changes unless you're typing here.
  useEffect(() => { if (document.activeElement !== ref.current) setText(show(budget)); }, [budget]);
  const commit = () => {
    const raw = text.trim();
    const v = raw ? parseKinah(raw) : null;
    if (raw && !(v > 0)) return setInvalid(true);
    setInvalid(false);
    writeRaw(KEYS.budget, v ? String(v) : null);
  };
  return (
    <input id="budget" ref={ref} type="text" inputMode="decimal" placeholder="e.g. 250m or 1.2b" autoComplete="off" value={text}
      aria-invalid={invalid || undefined} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      title="How much kinah you can put into crafting. Saved in this browser only; entries in the Profit Calculator update it." />
  );
}

/** A number input that updates on every valid keystroke, clamped, without fighting what you type. */
function NumInput({ id, value, lo, hi, step, inputMode, onChange }) {
  return (
    <input id={id} type="number" min={lo} max={hi} step={step} inputMode={inputMode} defaultValue={value}
      onInput={(e) => { const v = parseFloat(e.currentTarget.value); if (Number.isFinite(v)) onChange(Math.min(hi, Math.max(lo, v))); }} />
  );
}

// Crafting proficiency: grade + level per skill; stored as one 1-100 level (51-100 = Professional 1-50).
function ProfRow({ skill, level, onChange }) {
  const pro = level > 50;
  const [grade, setGrade] = useState(pro ? "pro" : "novice");
  const [text, setText] = useState(String(pro ? level - 50 : level));
  const update = (g, t) => {
    setGrade(g); setText(t);
    const lvl = Math.min(50, Math.max(1, parseInt(t, 10) || 1));
    onChange((g === "pro" ? 50 : 0) + lvl);
  };
  return (
    <div className="prof">
      <span className="prof-name">{skill}</span>
      <select aria-label={`${skill} grade`} value={grade} onChange={(e) => update(e.target.value, text)}>
        <option value="novice">Novice</option><option value="pro">Professional</option>
      </select>
      <input type="number" min="1" max="50" step="1" inputMode="numeric" aria-label={`${skill} level`} value={text} onChange={(e) => update(grade, e.target.value)} />
    </div>
  );
}

function Chips({ id, label, options, value, display = (v) => v, onChange }) {
  return (
    <div className="chips" id={id} role="group" aria-label={label}>
      {options.map((v) => <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{display(v)}</button>)}
    </div>
  );
}
function Seg({ id, label, options, value, onChange }) {
  return (
    <div className="seg" id={id} role="radiogroup" aria-label={label}>
      {options.map(([v, text, title]) => <button key={v} type="button" role="radio" aria-checked={v === value} title={title} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

function CopyLink() {
  const [label, setLabel] = useState("Copy share link");
  const click = async () => {
    try { await navigator.clipboard.writeText(location.href); setLabel("Link copied"); } catch { setLabel("Copy the address bar"); }
    setTimeout(() => setLabel("Copy share link"), 1800);
  };
  return <button className="link-btn" id="copyLink" type="button" onClick={click}>{label}</button>;
}

// ---------- KPIs ----------
function Kpis({ rows, sharePct }) {
  let tiles;
  if (noCostsInView(rows)) {
    const byTurnover = rows.filter((r) => r.turnover != null).sort((a, b) => b.turnover - a.turnover);
    const fastest = rows.filter((r) => r.perDay != null).sort((a, b) => b.perDay - a.perDay)[0];
    const total = byTurnover.reduce((s, r) => s + r.turnover, 0);
    const top = byTurnover[0];
    tiles = [
      { label: "Biggest market", name: !!top, value: top ? top.shortName : "—", sub: top ? `${kinah(top.turnover)} / day after fees` : "No sales estimates yet" },
      { label: "Fastest seller", name: !!fastest, value: fastest ? fastest.shortName : "—", sub: fastest ? `~${rate(fastest.perDay)} sold / day` : "No sales estimates yet" },
      { label: "Total turnover", value: kinah(total), sub: `per day across ${byTurnover.length} items, after fees` },
      { label: "Crafting cost", value: "TBD", sub: "profit and ranking need a cost model" },
    ];
  } else {
    const good = rows.filter((r) => isWorthCrafting(r.verdict));
    const best = [...rows].sort(byRank)[0];
    const pool = rows.reduce((s, r) => s + Math.max(0, r.dailyPool ?? 0), 0);
    const margins = rows.map((r) => r.marginPct).filter((v) => v != null).sort((a, b) => a - b);
    const median = margins.length ? margins[Math.floor(margins.length / 2)] : null;
    const yours = best?.yourDaily;
    // Best return on the capital you have to put up, among crafts that are profitable and actually selling.
    const bestRoc = rows.filter((r) => r.roc != null && r.roc > 0 && isWorthCrafting(r.verdict)).sort((a, b) => b.roc - a.roc)[0];
    const tbd = rows.filter((r) => r.cost == null).length;
    const profitable = best && best.dailyPool > 0;
    tiles = [
      { label: "Best craft right now", name: profitable, value: profitable ? best.shortName : "Nothing profitable", sub: profitable ? `${kinah(best.profit)} per craft · ${rate(best.perDay)}/day sold` : "Try another price basis" },
      { label: "Your expected daily profit", value: yours > 0 ? kinah(yours) : "—", sub: yours > 0 ? `from ${best.shortName} at ${sharePct}% share` : "No craft with positive profit and sales" },
      { label: "Worth crafting", value: `${good.length} of ${rows.filter((r) => r.cost != null).length}`, sub: tbd ? `of crafts with a known cost; ${tbd} with cost TBD` : "profitable, selling, not oversupplied" },
      bestRoc
        ? { label: "Best return on capital", name: true, value: bestRoc.shortName, sub: `${pct(bestRoc.roc)} · ${kinah(bestRoc.profit)} profit on ${kinah(bestRoc.capital)}` }
        : { label: "Median margin", value: pct(median), sub: `market-wide daily pool ${kinah(pool)}` },
    ];
  }
  return (
    <section className="kpis" id="kpis" aria-label="Summary">
      {tiles.map((t) => (
        <div className="kpi" key={t.label}>
          <div className="label">{t.label}</div>
          <div className={cx("value", t.name && "is-name")} title={t.value}>{t.value}</div>
          <div className="sub" title={t.sub}>{t.sub}</div>
        </div>
      ))}
    </section>
  );
}

// ---------- table ----------
function costTitle(r) {
  const d = r.costDetail;
  if (!d) return r.cost == null ? "No crafting cost known" : `Expected cost per item at your ${masteryLabel(r.playerLevel)} (success ${r.success != null ? asPct(r.success) : "—"}), cheapest path; expand the row for the recipe`;
  const base = `${d.baseName} ${kinah(d.base)} (${d.baseMethod === "craft" ? "crafted" : "bought"}; craft ${kinah(d.baseCraft)}, listing ${kinah(d.baseListing)})`;
  const mats = d.materials.map((m) => `${m.qty}× ${m.name} @ ${kinah(m.price)}`).join(", ");
  const per = `= ${kinah(d.attempt)} per craft attempt`;
  // Plain True Dragon divides by the success rate; the Splendent version by success × the combo chance.
  const pctOf = (x) => `${(x * 100).toFixed(x * 100 % 1 ? 1 : 0)}%`;
  const combo = d.factor === 1 ? ""
    : d.isCombo
      ? `; ÷ (${pctOf(d.success)} success × ${Math.round(d.comboProbability * 100)}% combo) = ${kinah(r.cost)}`
      : `; ÷ ${pctOf(d.success)} success = ${kinah(r.cost)}`;
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
const overTransfer = (r) => r.transfer?.cost != null && r.price != null && r.price > r.transfer.cost;

// Columns: fmt(row, ctx) draws the cell; ctx = { budget, open, icons }.
const COLUMNS = [
  { key: "rank", label: "#", cls: "rank", sortVal: (r) => -r.rank, fmt: (r) => (r.cost == null ? "—" : r.rank) },
  { key: "name", label: "Craft", cls: "name", sortVal: (r) => r.shortName,
    fmt: (r, { open, icons }) => (
      <span className="item-cell">
        <ItemIcon icon={icons[r.key]} />
        <span className="item-text">
          <button type="button" className="item-toggle" data-toggle={r.key} aria-expanded={open === r.key} title="Show the recipe and what goes into the cost">
            <span className="chev" aria-hidden="true">{open === r.key ? "▾" : "▸"}</span>{r.shortName}
          </button>
          <span className="meta">{r.tier === "Artisan's Splendent" ? "" : `${shortenName(r.tier)} · `}{r.skill} · {r.category}</span>
        </span>
        <ExtLink row={r} icon />
      </span>
    ) },
  { key: "verdict", label: "Verdict", sortVal: (r) => VERDICT_ORDER[r.verdict.id], fmt: (r) => <span className={`pill ${r.verdict.tone}`}>{r.verdict.label}</span> },
  { key: "cost", label: "Cost", fmt: (r) => (r.costDetail && r.cost != null ? "≈" : "") + kinah(r.cost), title: costTitle },
  { key: "price", label: "Sell price",
    fmt: (r) => <>{kinah(r.price)}{overTransfer(r) && <span className="over-transfer" aria-label="above the transfer-craft cost">▲</span>}</>,
    title: (r) => `Cheapest listing ${kinah(r.listing)} · avg sale ${kinah(r.soldAvg)}${r.priceSource === "estimate" ? " (estimated from listings that sold)" : r.priceSource === "official" ? " (28-day official)" : ""}` +
      (r.transfer?.cost != null ? `. Transfer craft makes a bound one for ${kinah(r.transfer.cost)}${overTransfer(r) ? ": buyers can make their own for less than this price" : ""}` : "") },
  { key: "profit", label: "Profit / craft", fmt: (r) => kinah(r.profit, { sign: true }), tone: (r) => (r.profit == null ? "dim" : r.profit > 0 ? "pos" : "neg") },
  { key: "marginPct", label: "Margin", fmt: (r) => pct(r.marginPct), title: () => "Profit ÷ average cost per item", tone: (r) => (r.marginPct == null ? "dim" : r.marginPct > 0 ? "pos" : "neg") },
  { key: "capital", label: "Capital needed", fmt: (r) => kinah(r.capital),
    title: (r, { budget }) => capitalTitle(r) + (budget > 0 && r.capital > budget ? `. More than your ${kinah(budget)}` : ""),
    tone: (r, { budget }) => (budget > 0 && r.capital != null && r.capital > budget ? "over-budget" : "") },
  { key: "roc", label: "Return on capital", fmt: (r) => pct(r.roc), title: capitalTitle, tone: (r) => (r.roc == null ? "dim" : r.roc > 0 ? "pos" : "neg") },
  { key: "perDay", label: "Sold / day", fmt: (r) => (r.salesSource === "estimate" ? "~" : "") + rate(r.perDay), title: salesTitle },
  { key: "listings", label: "Listings", fmt: (r) => r.listings },
  { key: "supplyDays", label: "Days supply", fmt: (r) => days(r.supplyDays),
    title: (r) => (r.daysToSell == null ? "No sales estimate" : `Current listings ÷ sold per day. A listing you post now would take about ${days(r.daysToSell)} days to sell (listings + 1 ÷ sold/day); listings expire after 3.`) },
  { key: "dailyPool", label: "Daily pool", fmt: (r) => kinah(r.dailyPool, { sign: true }), tone: (r) => (r.dailyPool == null ? "dim" : r.dailyPool < 0 ? "neg" : "") },
  { key: "turnover", label: "Turnover / day", fmt: (r) => kinah(r.turnover), tone: (r) => (r.turnover == null ? "dim" : ""),
    title: () => "Sell price after fees × sold per day: the size of the market, before crafting cost" },
  { key: "yourDaily", label: "Your daily", fmt: (r) => kinah(r.yourDaily, { sign: true }), tone: (r) => (r.yourDaily == null ? "dim" : r.yourDaily < 0 ? "neg" : "") },
];

function CraftTable({ rows, ui, setUi, budget, icons, chains }) {
  const { sort, dir, open } = ui;
  const body = useRef(null);
  const col = COLUMNS.find((c) => c.key === sort) || COLUMNS[0];
  const sorted = useMemo(() => {
    const val = col.sortVal || ((r) => r[col.key]);
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return dir === "asc" ? c : -c;
    });
  }, [rows, col, dir]);
  const ctx = { budget, open, icons };
  const topKey = (rows.find((r) => r.verdict.id === "top") || rows.find((r) => r.verdict.id === "craft"))?.key;
  const sortBy = (k) => setUi((u) => (u.sort === k ? { ...u, dir: u.dir === "desc" ? "asc" : "desc" } : { ...u, sort: k, dir: k === "name" ? "asc" : "desc" }));
  // Clicking an item row (anywhere but a link) expands its recipe; clicking it again closes it.
  const toggle = (e, key) => {
    if (e.target.closest("a")) return;
    setUi((u) => ({ ...u, open: u.open === key ? null : key }));
    if (open !== key) requestAnimationFrame(() => body.current?.querySelector(`[data-toggle="${key}"]`)?.focus({ preventScroll: true }));
  };
  return (
    <table id="table">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c.key} aria-sort={c.key === sort ? (dir === "asc" ? "ascending" : "descending") : undefined}>
              <button type="button" onClick={() => sortBy(c.key)}>{c.label}</button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody ref={body}>
        {sorted.length ? sorted.map((r) => (
          <Row key={r.key} r={r} ctx={ctx} top={r.key === topKey} onToggle={toggle} chains={chains} />
        )) : <tr><td colSpan={COLUMNS.length} className="dim">No crafts match these filters.</td></tr>}
      </tbody>
    </table>
  );
}

function Row({ r, ctx, top, onToggle, chains }) {
  const open = ctx.open === r.key;
  return <>
    <tr className={cx(top && "top-pick", "item-row", open && "open")} data-key={r.key} onClick={(e) => onToggle(e, r.key)}>
      {COLUMNS.map((c) => (
        <td key={c.key} className={cx(c.cls, c.tone?.(r, ctx)) || undefined} title={c.title ? c.title(r, ctx) : undefined}>{c.fmt(r, ctx)}</td>
      ))}
    </tr>
    {open && (
      <tr className="detail-row"><td colSpan={COLUMNS.length}><div className="detail-inner"><RecipeDetail row={r} chains={chains} /></div></td></tr>
    )}
  </>;
}

// ---------- page ----------
export default function Market() {
  const { snapshot, error: snapError } = useSnapshot();
  const [ui, setUi] = useState(readUrl);
  const set = (patch) => setUi((u) => ({ ...u, ...patch }));
  const budget0 = useKinah();
  const budget = budget0 > 0 ? budget0 : null;
  const ledgerRaw = useStoredRaw(KEYS.ledger); // a new listing in the calculator changes the plan
  const [tip, tipFor] = useTip();

  const servers = snapshot?.servers || [];
  // The link's (or saved) server, if the snapshot has it; otherwise the default.
  const sid = !snapshot || servers.some((x) => x.server_id === ui.server) ? ui.server
    : servers.some((x) => x.server_id === DEFAULT_SERVER) ? DEFAULT_SERVER : servers[0]?.server_id;
  const srv = servers.find((x) => x.server_id === sid);
  const asmo = srv?.faction === "Asmodian"; // Asmodian servers call the True Dragon tiers Star Dragon
  const { doc: loaded, loading, error: docError } = useServerDoc(snapshot, sid);
  const last = useRef(null);
  if (loaded) last.current = loaded;
  const doc = loaded || (loading ? last.current : null); // keep showing the last server while the next loads
  const market = doc?.market || null;

  useEffect(() => { if (snapshot) writeUrl({ ...ui, server: sid }); }, [ui, sid, snapshot]);

  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, priceBasis: ui.priceBasis, costBasis: ui.costBasis, salesTaxPct: ui.salesTaxPct,
    listingFeePct: ui.listingFeePct, sharePct: ui.sharePct, proficiency: ui.proficiency }),
  [ui.priceBasis, ui.costBasis, ui.salesTaxPct, ui.listingFeePct, ui.sharePct, ui.proficiency]);
  const all = useMemo(() => {
    if (!market) return null;
    const rows = analyzeMarket(market, settings);
    rows.forEach((r, i) => (r.rank = i + 1)); // rank within the whole server, before filters
    return rows;
  }, [market, settings]);
  const rows = useMemo(() => (all || []).filter((r) =>
    (ui.tier === "All" || r.tier === ui.tier) && (ui.skill === "All" || r.skill === ui.skill) && !(ui.hideLoss && r.profit != null && r.profit <= 0)),
  [all, ui.tier, ui.skill, ui.hideLoss]);

  // The plan's settings, saved so the Profit Calculator's copy of the plan matches this page.
  useEffect(() => {
    const { sharePct, priceBasis, costBasis, salesTaxPct, listingFeePct, tier, skill } = ui;
    writeRaw(KEYS.planSettings, JSON.stringify({ sharePct, priceBasis, costBasis, salesTaxPct, listingFeePct, tier, skill }));
  }, [ui.sharePct, ui.priceBasis, ui.costBasis, ui.salesTaxPct, ui.listingFeePct, ui.tier, ui.skill]);

  const icons = market?.icons || {};
  const plan = market && planView({
    rows, budget, settings, icons, snapshotAt: market.captured_at, serverName: srv?.name, entries: entriesOf(ledgerRaw),
    scope: "using the filters above and your proficiency",
    emptyHint: "Enter how much kinah you have above to see what to craft with it.",
  });

  const banner = snapError ? "Couldn't load market data. The snapshot hasn't been built yet, or the site is unreachable."
    : docError ? `Couldn't load data for ${serverLabel(srv) || "that server"}. It may not have been refreshed yet; try another server.` : null;
  const gen = doc?.generated_at ?? snapshot?.generated_at;
  const stale = gen && Date.now() - new Date(gen).getTime() > 3 * 3600e3;
  const regions = [...new Set(servers.map((x) => x.region_name || x.region))];
  const turnoverMode = noCostsInView(rows);
  const basis = { conservative: "lower of cheapest listing and average sale price", listing: "cheapest current listing", sold: "average sale price" }[ui.priceBasis];
  const model = snapshot?.model;

  return <>
    <header className="top">
      <div className="wrap top-inner">
        <div>
          <p className="eyebrow">Aion 2 · Expert's Splendent, Artisan's Splendent &amp; True / Star Dragon gear · <span id="serverName">{srv ? serverLabel(srv) : "Siel · Elyos · North America West"}</span></p>
          <h1>Crafting profit</h1>
          <p className="lede">Which crafts make money on <span className="server-short">{srv?.name || "Siel"}</span>, ranked by profit per craft <em>and</em> how fast they actually sell.</p>
        </div>
        <div className={cx("freshness", stale && "stale")} id="freshness" aria-live="polite"
          title={gen ? `Snapshot built ${new Date(gen).toLocaleString()}; refreshed about every 30 minutes` : undefined}>
          {snapError ? "No data" : !doc || (loading && !loaded) ? "Loading…" : <><span className="dot"></span>Updated {ago(gen)} · prices {ago(market?.captured_at)}</>}
        </div>
      </div>
    </header>

    <main className="wrap">
      {banner && <div className="banner" role="alert">{banner}</div>}
      <section className="controls" aria-label="Filters and assumptions">
        <label className="field server-field">
          <span>Server</span>
          <select id="server" aria-label="Server" value={sid ?? ""} onChange={(e) => { const v = +e.target.value; writeRaw(KEYS.server, String(v)); set({ server: v }); }}>
            {regions.map((rn) => (
              <optgroup key={rn} label={rn}>
                {servers.filter((x) => (x.region_name || x.region) === rn)
                  .sort((a, b) => a.server_id % 10000 - b.server_id % 10000 || a.server_id - b.server_id)
                  .map((x) => <option key={x.server_id} value={x.server_id}>{x.name} · {x.faction} · {REGION_SHORT[x.region] || x.region}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field budget-field">
          <span>Your kinah</span>
          <BudgetInput budget={budget} />
        </label>
        <div className="field">
          <span>Tier</span>
          <Chips id="tiers" label="Tier" options={TIERS} value={ui.tier} onChange={(tier) => set({ tier })}
            display={(v) => (asmo ? v.replace("True Dragon", "Star Dragon") : v)} />
        </div>
        <div className="field">
          <span>Skill</span>
          <Chips id="skills" label="Skill" options={SKILLS} value={ui.skill} onChange={(skill) => set({ skill })} />
        </div>
        <div className="field">
          <span>Sell price</span>
          <Seg id="priceBasis" label="Sell price basis" value={ui.priceBasis} onChange={(priceBasis) => set({ priceBasis })} options={[
            ["conservative", "Conservative", "Lower of the cheapest listing and the average sale price"],
            ["listing", "Cheapest listing", "Cheapest listing right now"],
            ["sold", "Avg sale price", "Average price of listings that sold over the last 7 days"],
          ]} />
        </div>
        <div className="field">
          <span>Material cost</span>
          <Seg id="costBasis" label="Material cost basis" value={ui.costBasis} onChange={(costBasis) => set({ costBasis })} options={[
            ["cheapest", "Cheapest path", "Cheapest path per input: buy, convert Odyle, or craft it"],
            ["market", "Buy everything", "Buy every input off the exchange"],
          ]} />
        </div>
        <label className="field small">
          <span>Sales tax %</span>
          <NumInput id="tax" value={ui.salesTaxPct} lo={0} hi={50} step="0.5" inputMode="decimal" onChange={(salesTaxPct) => set({ salesTaxPct })} />
        </label>
        <label className="field small">
          <span>Listing fee %</span>
          <NumInput id="listFee" value={ui.listingFeePct} lo={0} hi={50} step="0.5" inputMode="decimal" onChange={(listingFeePct) => set({ listingFeePct })} />
        </label>
        <label className="field small">
          <span>Your share of sales %</span>
          <NumInput id="share" value={ui.sharePct} lo={1} hi={100} step="1" inputMode="numeric" onChange={(sharePct) => set({ sharePct })} />
        </label>
        <div className="field prof-field">
          <span>Your crafting proficiency</span>
          <div className="profs" id="proficiency" role="group" aria-label="Crafting proficiency per skill">
            {CRAFT_SKILLS.map((k) => (
              <ProfRow key={k} skill={k} level={ui.proficiency[k]} onChange={(level) => {
                const proficiency = { ...ui.proficiency, [k]: level };
                writeRaw(KEYS.proficiency, JSON.stringify(proficiency));
                set({ proficiency });
              }} />
            ))}
          </div>
        </div>
        <label className="check">
          <input id="hideLoss" type="checkbox" checked={ui.hideLoss} onChange={(e) => set({ hideLoss: e.target.checked })} /> Hide losses
        </label>
        <CopyLink />
      </section>

      {market && <Kpis rows={rows} sharePct={ui.sharePct} />}
      {!market && <section className="kpis" id="kpis" aria-label="Summary" />}

      <section className="panel plan" aria-labelledby="planTitle">
        <div className="table-head">
          <h2 id="planTitle">What to craft with your kinah</h2>
          <p className="muted" id="planNote">{plan?.note}</p>
        </div>
        <div id="planBody">{plan?.body}</div>
      </section>

      <section className="charts">
        <figure className="panel">
          <figcaption>
            <h2 id="barTitle">{turnoverMode ? "Turnover per day, whole market" : "Expected daily profit, whole market"}</h2>
            <p id="barNote">{turnoverMode
              ? "Sell price after fees × units sold per day. Crafting cost isn't known for these tiers yet, so this is market size, not profit."
              : "Profit per craft × units sold per day. This is the pool every crafter on the server is competing for."}</p>
          </figcaption>
          <div className="chart" id="barChart">{market && <BarChart rows={rows} tipFor={tipFor} />}</div>
        </figure>
        <figure className="panel">
          <figcaption>
            <h2>Margin vs. how fast it sells</h2>
            <p>Top right is where you want to be. The dashed line marks break-even; solid dots are Top pick or Craft it; crafts with no sales in the last 7 days are left out.</p>
          </figcaption>
          <div className="chart" id="scatter">{market && <Scatter rows={rows} tipFor={tipFor} />}</div>
        </figure>
      </section>

      <section className="panel table-panel">
        <div className="table-head">
          <h2>All crafts</h2>
          <p className="muted" id="tableNote">{market && `${rows.length} crafts · ~ = estimated from listing history · sell price = ${basis}${ui.salesTaxPct + ui.listingFeePct ? `, minus ${ui.salesTaxPct}% tax and ${ui.listingFeePct}% listing fee` : ""}`}</p>
        </div>
        <div className="table-scroll">
          {market ? <CraftTable rows={rows} ui={ui} setUi={setUi} budget={budget} icons={icons} chains={all?.chains || market.chains} />
            : <table id="table"><thead /><tbody /></table>}
        </div>
      </section>

      <MarketMethod modelNote={model ? `Cost model #${model.model_id ?? "?"} (algorithm v${model.algorithm_version ?? "?"}, mastery ${model.mastery ?? "?"}), built from game files.` : ""} />
    </main>

    <footer className="wrap foot">
      Data from <a href="https://aion2.exchange" target="_blank" rel="noopener">aion2.exchange</a>. Not affiliated with NCSOFT.
    </footer>
    <Tooltip tip={tip} icons={icons} />
  </>;
}
