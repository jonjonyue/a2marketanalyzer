import { useEffect, useRef, useState } from "react";
import { planBudget } from "../lib/metrics.js";
import { ownListings, ownActiveListings, activeListingCount, stackableTest } from "../lib/ledgerStore.js";
import { kinah, pct, days } from "../lib/format.js";
import { ItemIcon } from "./ItemIcon.jsx";
import { SupplyTag } from "./Supply.jsx";
import { KEYS, writeRaw } from "../lib/storage.js";

/** The plan's goal switch: most total profit, or most profit per day (faster sellers win). Shared by both pages. */
export function PlanGoal({ goal }) {
  const set = (v) => writeRaw(KEYS.planGoal, v);
  return (
    <div className="seg plan-goal" role="radiogroup" aria-label="Plan for">
      <button type="button" role="radio" aria-checked={goal !== "perDay"} onClick={() => set("total")} title="The mix that earns the most in total">Most profit</button>
      <button type="button" role="radio" aria-checked={goal === "perDay"} onClick={() => set("perDay")} title="The mix that earns the most per day: profit ÷ days until it sells, so fast sellers win">Profit per day</button>
    </div>
  );
}

const REFRESH = "a2:plan-refresh";
/** Ask any plan on the page to take your current kinah and listings (typing your kinah does this). */
export function requestPlanRefresh() { window.dispatchEvent(new Event(REFRESH)); }

/**
 * Holds the plan's kinah and listings still, so logging a buy or a listing doesn't reshuffle the plan while you
 * work through it. It takes the live values on page load, when the server changes, when you first set your kinah,
 * when you type your kinah, and on Refresh. Settings (goal, filters, fees) always apply right away.
 * "+ List" marks a craft listed (`markListed`), which takes it off the held plan until the next refresh.
 * Returns { budget, entries, now, listed, stale, refresh, markListed }.
 */
export function useHeldPlan({ ready, server, budget, entries }) {
  const live = { server, budget, entries, now: Date.now() };
  const liveRef = useRef(live);
  liveRef.current = live;
  const [held, setHeld] = useState(null);
  const [want, setWant] = useState(0);
  useEffect(() => {
    const f = () => setWant((w) => w + 1);
    window.addEventListener(REFRESH, f);
    return () => window.removeEventListener(REFRESH, f);
  }, []);
  useEffect(() => { if (want && ready) setHeld(liveRef.current); }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
  const take = ready && (!held || held.server !== server || (held.budget == null && budget != null));
  useEffect(() => { if (take) setHeld(liveRef.current); }, [take]);
  const h = take || !held ? live : held;
  // Units listed from the plan since it was made, by craft key (n < 0 undoes).
  const markListed = (key, n) => setHeld((x) => x && { ...x, listed: { ...x.listed, [key]: Math.max(0, (x.listed?.[key] || 0) + n) } });
  return { budget: h.budget, entries: h.entries, now: h.now, listed: h.listed || {},
    stale: !take && !!held && (held.budget !== budget || held.entries !== entries),
    refresh: () => setWant((w) => w + 1), markListed };
}

/** The plan's Refresh button: lit up when your kinah or listings changed since the plan was made. */
export function PlanRefresh({ stale, onClick }) {
  return (
    <button type="button" className={`mini-btn plan-refresh${stale ? " stale" : ""}`} onClick={onClick}
      title={stale ? "Your kinah or listings changed since this plan was made. Refresh to use them." : "Remake the plan with your current kinah and listings"}>
      ↻ Refresh{stale ? " (changed)" : ""}
    </button>
  );
}

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
export function planView({ rows, budget, settings, serverName, icons = {}, scope = "", emptyHint, snapshotAt = null, entries = [], now = Date.now(), listed = {}, onList = null }) {
  if (!budget) {
    return { note: "", body: <p className="muted plan-empty">{emptyHint || "Enter how much kinah you have to see what to craft with it."}</p> };
  }
  const plan = planBudget(rows, budget, { ...settings, ownListings: ownListings(entries), ownActive: ownActiveListings(entries, now), ownActiveCount: activeListingCount(entries, now, stackableTest(rows)),
    snapshotAt: snapshotAt ? Math.floor(new Date(snapshotAt).getTime() / 60000) : null });
  // Crafts you've listed from this plan (since the last refresh) come off it; the totals cover what's left.
  const doneUnits = (p) => Math.min(p.units, listed[p.row.key] || 0);
  const isDone = (p) => doneUnits(p) >= (p.row.stackable ? 1 : p.units);
  const done = plan.picks.filter(isDone);
  if (done.length) {
    const picks = plan.picks.filter((p) => !isDone(p));
    const sum = (f) => picks.reduce((t, p) => t + f(p), 0);
    const capital = sum((p) => p.capital), profit = sum((p) => p.profit);
    Object.assign(plan, { picks, capital, profit, spend: sum((p) => p.spend), profitPerDay: sum((p) => p.profitPerDay),
      roi: capital ? (profit / capital) * 100 : null });
    // Their listing slots move from "planned" to "listed".
    const moved = done.reduce((t, p) => t + (p.row.stackable ? 1 : p.units), 0);
    plan.slots = { ...plan.slots, yours: plan.slots.yours + moved, planned: Math.max(0, plan.slots.planned - moved) };
  }
  const listedNote = done.length > 0 && (
    <p className="muted small plan-listed">
      Listed from this plan:{" "}
      {done.map((p, i) => <span key={p.row.key}>{i ? ", " : ""}<strong>{p.row.shortName}</strong>{p.units > 1 ? ` (${p.units})` : ""}</span>)}.
      {" "}Refresh for a new plan.
    </p>
  );
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
      {listedNote}
      {covered}
      {full ? slotNote : plan.nextUp
        ? <p className="plan-empty">Nothing fits {kinah(budget)} yet. Cheapest good option: <strong>{plan.nextUp.row.shortName}</strong>, about <strong>{kinah(plan.nextUp.capital)}</strong>.</p>
        : !plan.covered.length && !done.length && <p className="plan-empty muted">Nothing worth crafting right now.</p>}
    </> };
  }
  const body = <>
    <div className="plan-summary">
      <div><span className="label">Expected profit</span><strong className="pos">{kinah(plan.profit, { sign: true })}</strong><span className="sub">{pct(plan.roi)} on what you set aside · ~{kinah(plan.profitPerDay)}/day</span></div>
      <div><span className="label">Set aside</span><strong>{kinah(plan.capital)}</strong><span className="sub">average spend {kinah(plan.spend)}</span></div>
      <div><span className="label">Left over</span><strong>{kinah(plan.left)}</strong><span className="sub">{plan.picks.length} of {plan.candidates} worthwhile crafts</span></div>
    </div>
    <div className="table-scroll">
      <table className="plan-table">
        <thead><tr>{onList && <th><span className="sr-only">Log a listing</span></th>}<th>Craft</th><th>Verdict</th><th>Make</th><th>Set aside <span className="th-sub">total</span></th><th>Avg spend <span className="th-sub">total</span></th><th>List at <span className="th-sub">each</span></th><th>Profit <span className="th-sub">total</span></th><th>Profit <span className="th-sub">per day</span></th><th>Return</th><th>Sells in</th></tr></thead>
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
                {doneUnits(p) > 0 && <> <span className="dim">({doneUnits(p)} listed)</span></>}
                {p.myUnits > 0 && <> <span className="dim" title={`You already have ${p.myUnits} listed (Profit Calculator); they take ${p.myUnits === 1 ? "a place" : "places"} in the market's room`}>+{p.myUnits} listed</span></>}
              </td>
              <td title={`For 90% odds of making ${p.units}`}>{kinah(p.capital)}</td>
              <td title={`Average spend for ${p.units}${p.units > 1 ? ` (${kinah(p.spend / p.units)} each)` : ""}`}>{kinah(p.spend)}</td>
              <td title={listTitle(p)}><strong>{kinah(p.listAt)}</strong>{p.units > 1 && <span className="dim"> ×{p.units}</span>}</td>
              <td className={p.profit > 0 ? "pos" : "neg"} title={`At ${kinah(p.listAt)} each you keep ${kinah(p.netEach)} after tax and fee${p.units > 1 ? `; ${kinah(p.profit / p.units, { sign: true })} profit each, ${p.units} units` : ""}`}>{kinah(p.profit, { sign: true })}</td>
              <td className={p.profitPerDay > 0 ? "pos" : "neg"} title="Profit ÷ days until your last one sells (at least 6 hours)">{kinah(p.profitPerDay, { sign: true })}</td>
              <td>{pct(p.row.roc)}</td>
              <td title="When your last one should sell">{days(p.daysToSell)} d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {listedNote}
    {covered}
    {slotNote}
    {freeAfter > 0 && plan.nextUp
      ? <p className="muted small">Next up: <strong>{plan.nextUp.row.shortName}</strong> needs {kinah(plan.nextUp.short)} more.</p>
      : null}
  </>;
  return { note, body, plan };
}
