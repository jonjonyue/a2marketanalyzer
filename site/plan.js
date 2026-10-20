// "What to craft with your kinah": shared by the Market Analysis page and the Profit Calculator.
import { planBudget, shortenName } from "./metrics.js";

const kinah = (v, { sign = false } = {}) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
  return s + Math.round(a);
};
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + "%");
const rate = (v) => (v == null ? "—" : v.toFixed(1));
const days = (v) => (v == null ? "—" : v === Infinity ? "∞" : v >= 100 ? "99+" : v.toFixed(1));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const LEDGER_STORE = "a2ledger.v1";

/** Your listings logged in the Profit Calculator (this browser), by item key and by name: [{ t (epoch minutes), price }]. */
export function ownListings() {
  const map = new Map();
  try {
    const entries = JSON.parse(localStorage.getItem(LEDGER_STORE) || "null")?.entries || [];
    for (const e of entries) {
      if (e.side !== "list" || !(e.price > 0) || !Number.isFinite(e.ts)) continue;
      const item = { t: Math.floor(e.ts / 60000), price: e.price };
      for (const k of [e.key, shortenName(String(e.name || "")).toLowerCase()]) {
        if (k == null || k === "") continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(item);
      }
    }
  } catch { /* no log, or storage blocked */ }
  return map;
}

function listTitle(p) {
  const r = p.row;
  return `${p.listNote || ""} Cheapest listing ${r.listing > 0 ? kinah(r.listing) : "none"} · ${r.listings ?? 0} listed. ` +
    `List all ${p.units} at this price: going lower on later ones only undercuts your own.`;
}

/**
 * The plan panel's contents. `iconHtml(key)` draws an item icon; `scope` describes what the plan covers
 * (e.g. "using the filters above and your proficiency"); `emptyHint` is shown when no kinah is set.
 * Returns { note, html }.
 */
export function planPanel({ rows, budget, settings, serverName, iconHtml = () => "", scope = "", emptyHint }) {
  if (!budget) {
    return { note: "", html: `<p class="muted plan-empty">${emptyHint || "Enter how much kinah you have to see what to craft with it."}</p>` };
  }
  const plan = planBudget(rows, budget, { ...settings, ownListings: ownListings() });
  const note = `For ${kinah(budget)} on ${serverName || "this server"}${scope ? `, ${scope}` : ""}.`;
  if (!plan.picks.length) {
    return { note, html: plan.nextUp
      ? `<p class="plan-empty">Nothing worth crafting fits ${kinah(budget)} yet. The best option, <strong>${esc(plan.nextUp.row.shortName)}</strong>, needs about <strong>${kinah(plan.nextUp.capital)}</strong> to be 90% sure of making one.</p>`
      : `<p class="plan-empty muted">No craft in view is currently worth making (Top pick or Craft it). Try other filters or a different server.</p>` };
  }
  const rowsHtml = plan.picks.map((p) => `<tr>
      <td class="name"><span class="item-cell">${iconHtml(p.row.key, "small")}<span>${esc(p.row.shortName)}</span></span></td>
      <td><span class="pill ${p.row.verdict.tone}">${esc(p.row.verdict.label)}</span></td>
      <td title="Room for about ${p.slots} from you in one 3-day listing: your first sells once the ${p.row.listings} current listings clear (${rate(p.row.perDay)}/day); each extra one only gets your ${settings.sharePct}% share of the sales left after that, since other sellers keep relisting and your own listings compete with each other">${p.units}${p.units < p.slots ? ` <span class="dim">of ${p.slots}</span>` : ""}</td>
      <td title="Kinah to set aside for 90% odds of making ${p.units} (combo luck included)">${kinah(p.capital)}</td>
      <td title="Average spend for ${p.units}">${kinah(p.spend)}</td>
      <td title="${esc(listTitle(p))}"><strong>${kinah(p.listAt)}</strong></td>
      <td class="${p.profit > 0 ? "pos" : "neg"}" title="At ${kinah(p.listAt)} each you keep ${kinah(p.netEach)} after tax and fee">${kinah(p.profit, { sign: true })}</td>
      <td>${pct(p.row.roc)}</td>
      <td title="When your last one should sell: the current listings and your first at the market's pace, then your ${settings.sharePct}% share of sales for each extra">${days(p.daysToSell)} d</td>
    </tr>`).join("");
  const next = plan.nextUp
    ? `<p class="muted small">Next up: <strong>${esc(plan.nextUp.row.shortName)}</strong> (${pct(plan.nextUp.row.roc)} return) needs ${kinah(plan.nextUp.capital)} set aside, ${kinah(plan.nextUp.short)} more than you have left.</p>`
    : plan.left > 0 && plan.picks.length === plan.candidates
      ? `<p class="muted small">That covers every craft worth making right now at the amount the market can take; the remaining ${kinah(plan.left)} has nowhere better to go until listings sell or prices change.</p>`
      : "";
  const html = `<div class="plan-summary">
      <div><span class="label">Expected profit</span><strong class="pos">${kinah(plan.profit, { sign: true })}</strong><span class="sub">${pct(plan.roi)} on what you set aside</span></div>
      <div><span class="label">Set aside</span><strong>${kinah(plan.capital)}</strong><span class="sub">average spend ${kinah(plan.spend)}</span></div>
      <div><span class="label">Left over</span><strong>${kinah(plan.left)}</strong><span class="sub">${plan.picks.length} of ${plan.candidates} worthwhile crafts</span></div>
    </div>
    <div class="table-scroll"><table class="plan-table"><thead><tr><th>Craft</th><th>Verdict</th><th>Make</th><th>Set aside</th><th>Avg spend</th><th>List at</th><th>Profit</th><th>Return</th><th>Sells in</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    ${next}
    <p class="muted small">Best return on capital first. "Set aside" covers bad luck on combo crafts (90% odds of making them all); on average you spend less and keep the rest. Each craft is capped at what one 3-day listing can sell: one beyond the current listings, plus extras only where your share of the remaining sales leaves room, since other sellers keep relisting and extra copies compete with your own.</p>`;
  return { note, html };
}
