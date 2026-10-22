import { planBudget } from "../lib/metrics.js";
import { ownListings, ownActiveListings } from "../lib/ledgerStore.js";
import { kinah, pct, rate, days } from "../lib/format.js";
import { ItemIcon } from "./ItemIcon.jsx";

// "What to craft with your kinah": shared by Market Analysis and the Profit Calculator.

function listTitle(p) {
  const r = p.row;
  return `${p.listNote || ""} Cheapest listing ${r.listing > 0 ? kinah(r.listing) : "none"} · ${r.listings ?? 0} listed. ` +
    `List all ${p.units} at this price: going lower on later ones only undercuts your own.`;
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
  const plan = planBudget(rows, budget, { ...settings, ownListings: ownListings(entries), ownActive: ownActiveListings(entries),
    snapshotAt: snapshotAt ? Math.floor(new Date(snapshotAt).getTime() / 60000) : null });
  const note = `For ${kinah(budget)} on ${serverName || "this server"}${scope ? `, ${scope}` : ""}.`;
  const icon = (key) => <ItemIcon icon={icons[key]} size="small" />;
  const coveredUnits = plan.covered.reduce((t, c) => t + c.myUnits, 0);
  const covered = plan.covered.length > 0 && (
    <p className="muted small plan-covered">
      Already covered by your listings:{" "}
      {plan.covered.map((c, i) => (
        <span key={c.row.key}>{i ? ", " : ""}<strong>{c.row.shortName}</strong> ({c.myUnits} listed, room for {c.room})</span>
      ))}. Wait for {coveredUnits === 1 ? "it" : "those"} to sell before making more.
    </p>
  );
  if (!plan.picks.length) {
    return { note, body: <>
      {covered}
      {plan.nextUp
        ? <p className="plan-empty">Nothing worth crafting fits {kinah(budget)} yet. The best option, <strong>{plan.nextUp.row.shortName}</strong>, needs about <strong>{kinah(plan.nextUp.capital)}</strong> to be 90% sure of making one.</p>
        : !plan.covered.length && <p className="plan-empty muted">No craft in view is currently worth making (Top pick or Craft it). Try other filters or a different server.</p>}
    </> };
  }
  const share = settings.sharePct;
  const body = <>
    <div className="plan-summary">
      <div><span className="label">Expected profit</span><strong className="pos">{kinah(plan.profit, { sign: true })}</strong><span className="sub">{pct(plan.roi)} on what you set aside</span></div>
      <div><span className="label">Set aside</span><strong>{kinah(plan.capital)}</strong><span className="sub">average spend {kinah(plan.spend)}</span></div>
      <div><span className="label">Left over</span><strong>{kinah(plan.left)}</strong><span className="sub">{plan.picks.length} of {plan.candidates} worthwhile crafts</span></div>
    </div>
    <div className="table-scroll">
      <table className="plan-table">
        <thead><tr>{onList && <th><span className="sr-only">Log a listing</span></th>}<th>Craft</th><th>Verdict</th><th>Make</th><th>Set aside</th><th>Avg spend</th><th>List at</th><th>Profit</th><th>Return</th><th>Sells in</th></tr></thead>
        <tbody>
          {plan.picks.map((p) => (
            <tr key={p.row.key}>
              {onList && (
                <td className="plan-list">
                  <button type="button" className="mini-btn" disabled={!(p.listAt > 0)} onClick={() => onList(p)}
                    title={p.listAt > 0 ? `Log a listing of 1 ${p.row.shortName} at ${kinah(p.listAt)} in the Profit Calculator (listing fee ${kinah(p.listAt * settings.listingFeePct / 100)})` : "No suggested price"}
                    aria-label={`List 1 ${p.row.shortName} at ${kinah(p.listAt)}`}>+ List</button>
                </td>
              )}
              <td className="name"><span className="item-cell">{icon(p.row.key)}<span>{p.row.shortName}</span></span></td>
              <td><span className={`pill ${p.row.verdict.tone}`}>{p.row.verdict.label}</span></td>
              <td title={`Room for about ${p.slots} from you in the next ${settings.planDays ?? 1.5} days of sales: your first sells once the ${p.row.listings} current listings clear (${rate(p.row.perDay)}/day); each extra one only gets your ${share}% share of the sales left after that, since other sellers keep relisting and your own listings compete with each other`}>
                {p.units}
                {p.units < p.slots && <> <span className="dim">of {p.slots}</span></>}
                {p.myUnits > 0 && <> <span className="dim" title={`You already have ${p.myUnits} listed (Profit Calculator); they take ${p.myUnits === 1 ? "a place" : "places"} in the market's room`}>+{p.myUnits} listed</span></>}
              </td>
              <td title={`Kinah to set aside for 90% odds of making ${p.units} (combo luck included)`}>{kinah(p.capital)}</td>
              <td title={`Average spend for ${p.units}`}>{kinah(p.spend)}</td>
              <td title={listTitle(p)}><strong>{kinah(p.listAt)}</strong></td>
              <td className={p.profit > 0 ? "pos" : "neg"} title={`At ${kinah(p.listAt)} each you keep ${kinah(p.netEach)} after tax and fee`}>{kinah(p.profit, { sign: true })}</td>
              <td>{pct(p.row.roc)}</td>
              <td title={`When your last one should sell: the current listings and your first at the market's pace, then your ${share}% share of sales for each extra`}>{days(p.daysToSell)} d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {covered}
    {plan.nextUp
      ? <p className="muted small">Next up: <strong>{plan.nextUp.row.shortName}</strong> ({pct(plan.nextUp.row.roc)} return) needs {kinah(plan.nextUp.capital)} set aside, {kinah(plan.nextUp.short)} more than you have left.</p>
      : plan.left > 0 && plan.picks.length === plan.candidates
        ? <p className="muted small">That covers every craft worth making right now at the amount the market can take; the remaining {kinah(plan.left)} has nowhere better to go until listings sell or prices change.</p>
        : null}
    <p className="muted small">Best return on capital first. "Set aside" covers bad luck on combo crafts (90% odds of making them all); on average you spend less and keep the rest. Each craft is capped at what the market can take in the next 1.5 days, so you stay flexible as prices move: one beyond the current listings, plus extras only where your share of the remaining sales leaves room, since other sellers keep relisting and extra copies compete with your own.</p>
  </>;
  return { note, body };
}
