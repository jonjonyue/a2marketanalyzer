import { planBudget } from "../lib/metrics.js";
import { ownListings, ownActiveListings, activeListingCount } from "../lib/ledgerStore.js";
import { kinah, pct, days } from "../lib/format.js";
import { ItemIcon } from "./ItemIcon.jsx";
import { SupplyTag } from "./Supply.jsx";

// "What to craft with your kinah": shared by Market Analysis and the Profit Calculator.

function listTitle(p) {
  const r = p.row;
  return `${p.listNote || ""} Cheapest listing ${r.listing > 0 ? kinah(r.listing) : "none"} · ${r.listings ?? 0} listed.` +
    (p.units > 1 ? ` List all ${p.units} at this price.` : "");
}

/**
 * The plan for `budget`: returns { note, body }. `entries` are the Profit Calculator's logged entries (your own
 * listings count); `icons` is the market's icon map; `scope` describes what the plan covers. `onList(pick)`, if given,
 * adds a button per craft that logs a listing of one at the suggested price.
 */
export function planView({ rows, budget, settings, serverName, icons = {}, scope = "", emptyHint, snapshotAt = null, entries = [], onList = null }) {
  if (!budget) {
    return { note: "", body: <p className="muted plan-empty">{emptyHint || "Enter how much kinah you have to see what to craft with it."}</p> };
  }
  const plan = planBudget(rows, budget, { ...settings, ownListings: ownListings(entries), ownActive: ownActiveListings(entries), ownActiveCount: activeListingCount(entries),
    snapshotAt: snapshotAt ? Math.floor(new Date(snapshotAt).getTime() / 60000) : null });
  const note = `For ${kinah(budget)} on ${serverName || "this server"}${scope ? `, ${scope}` : ""}.`;
  const icon = (key) => <ItemIcon icon={icons[key]} size="small" />;
  const covered = plan.covered.length > 0 && (
    <p className="muted small plan-covered">
      Already listed enough:{" "}
      {plan.covered.map((c, i) => (
        <span key={c.row.key}>{i ? ", " : ""}<strong>{c.row.shortName}</strong> ({c.myUnits})</span>
      ))}.
    </p>
  );
  // The exchange's limit on listings at once (per character): yours already up, plus what this plan would list.
  const { total, yours, planned, capped } = plan.slots;
  const full = yours >= total;
  const freeAfter = total - yours - planned;
  const slotNote = full
    ? <p className="plan-empty">All {total} listing slots are in use. Wait for some to sell.</p>
    : yours > 0 || planned > 0
      ? <p className="muted small plan-slots">Listing slots: {yours + planned} of {total}{yours ? ` (${yours} listed, ${planned} planned)` : ""}{capped ? ". Full." : "."}</p>
      : null;
  if (!plan.picks.length) {
    return { note, plan, body: <>
      {covered}
      {full ? slotNote : plan.nextUp
        ? <p className="plan-empty">Nothing fits {kinah(budget)} yet. Cheapest good option: <strong>{plan.nextUp.row.shortName}</strong>, about <strong>{kinah(plan.nextUp.capital)}</strong>.</p>
        : !plan.covered.length && <p className="plan-empty muted">Nothing worth crafting right now.</p>}
    </> };
  }
  const body = <>
    <div className="plan-summary">
      <div><span className="label">Expected profit</span><strong className="pos">{kinah(plan.profit, { sign: true })}</strong><span className="sub">{pct(plan.roi)} on what you set aside</span></div>
      <div><span className="label">Set aside</span><strong>{kinah(plan.capital)}</strong><span className="sub">average spend {kinah(plan.spend)}</span></div>
      <div><span className="label">Left over</span><strong>{kinah(plan.left)}</strong><span className="sub">{plan.picks.length} of {plan.candidates} worthwhile crafts</span></div>
    </div>
    <div className="table-scroll">
      <table className="plan-table">
        <thead><tr>{onList && <th><span className="sr-only">Log a listing</span></th>}<th>Craft</th><th>Verdict</th><th>Make</th><th>Set aside <span className="th-sub">total</span></th><th>Avg spend <span className="th-sub">total</span></th><th>List at <span className="th-sub">each</span></th><th>Profit <span className="th-sub">total</span></th><th>Return</th><th>Sells in</th></tr></thead>
        <tbody>
          {plan.picks.map((p) => (
            <tr key={p.row.key}>
              {onList && (
                <td className="plan-list">
                  <button type="button" className="mini-btn" disabled={!(p.listAt > 0) || full} onClick={() => onList(p)}
                    title={full ? `All ${total} listing slots are in use` : p.listAt > 0 ? `Log a listing of 1 ${p.row.shortName} at ${kinah(p.listAt)} in the Profit Calculator (listing fee ${kinah(p.listAt * settings.listingFeePct / 100)})` : "No suggested price"}
                    aria-label={`List 1 ${p.row.shortName} at ${kinah(p.listAt)}`}>+ List</button>
                </td>
              )}
              <td className="name"><span className="item-cell">{icon(p.row.key)}<span>{p.row.shortName}</span> <SupplyTag influx={p.row.influx} /></span></td>
              <td><span className={`pill ${p.row.verdict.tone}`}>{p.row.verdict.label}</span></td>
              <td title={`Room for ${p.slots} in the next ${settings.planDays ?? 1.5} days of sales`}>
                {p.units}
                {p.units < p.slots && <> <span className="dim">of {p.slots}</span></>}
                {p.myUnits > 0 && <> <span className="dim" title={`You already have ${p.myUnits} listed (Profit Calculator); they take ${p.myUnits === 1 ? "a place" : "places"} in the market's room`}>+{p.myUnits} listed</span></>}
              </td>
              <td title={`For 90% odds of making ${p.units}`}>{kinah(p.capital)}</td>
              <td title={`Average spend for ${p.units}${p.units > 1 ? ` (${kinah(p.spend / p.units)} each)` : ""}`}>{kinah(p.spend)}</td>
              <td title={listTitle(p)}><strong>{kinah(p.listAt)}</strong>{p.units > 1 && <span className="dim"> ×{p.units}</span>}</td>
              <td className={p.profit > 0 ? "pos" : "neg"} title={`At ${kinah(p.listAt)} each you keep ${kinah(p.netEach)} after tax and fee${p.units > 1 ? `; ${kinah(p.profit / p.units, { sign: true })} profit each, ${p.units} units` : ""}`}>{kinah(p.profit, { sign: true })}</td>
              <td>{pct(p.row.roc)}</td>
              <td title="When your last one should sell">{days(p.daysToSell)} d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {covered}
    {slotNote}
    {freeAfter > 0 && plan.nextUp
      ? <p className="muted small">Next up: <strong>{plan.nextUp.row.shortName}</strong> needs {kinah(plan.nextUp.short)} more.</p>
      : null}
  </>;
  return { note, body, plan };
}
