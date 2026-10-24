// "When buyers are active": hour-of-day and day-of-week activity from metrics.activityProfile, in local time.

export const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
export const windowLabel = (w) => `${hourLabel(w.start)} – ${hourLabel(w.end)}`;
const pc = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One line for other panels: "Best time to list: 11 PM – 2 AM". */
export function bestTimeNote(a) {
  return a?.best ? `Best time to list: ${windowLabel(a.best)} (${pc(a.best.rate)} sell before being undercut vs ${pc(a.avg)} on average)` : "";
}

export function ActivityPanel({ activity: a, serverName }) {
  if (!a) return null;
  const maxSales = Math.max(...a.hours.map((h) => h.salesPerHour), 1);
  const inBest = (h) => a.best && ((h - a.best.start + 24) % 24) < 3;
  const days = Math.max(1, Math.round((a.span[1] - a.span[0]) / 1440));
  const maxDay = Math.max(...a.days.map((d) => d.perDay || 0), 1);
  return (
    <section className="panel activity-panel" aria-labelledby="activityTitle">
      <div className="table-head">
        <h2 id="activityTitle">When buyers are active</h2>
        <p className="muted">{serverName || "This server"} · your local time · last {days} days</p>
      </div>
      {a.best && (
        <p className="activity-best">
          List around <strong>{windowLabel(a.best)}</strong>: {pc(a.best.rate)} of new cheapest listings sold before being undercut, vs {pc(a.avg)} on average
          {a.worst ? <> and {pc(a.worst.rate)} at {windowLabel(a.worst)}</> : null}.
        </p>
      )}
      <div className="hours" role="img" aria-label="Sales per hour by hour of day">
        {a.hours.map((h, i) => (
          <div key={i} className={`hour${inBest(i) ? " best" : ""}`}
            title={`${hourLabel(i)}: ${h.salesPerHour.toFixed(1)} sales/hr, ${h.cutsPerHour.toFixed(1)} undercuts/hr, ${pc(h.rate)} sold before being undercut`}>
            <div className="bar" style={{ height: `${Math.max(3, (h.salesPerHour / maxSales) * 100)}%`, opacity: h.rate == null ? 0.35 : 0.35 + Math.min(1, h.rate / 0.5) * 0.65 }} />
            <span className="lbl">{i % 3 === 0 ? hourLabel(i).replace(" ", "").toLowerCase() : ""}</span>
          </div>
        ))}
      </div>
      <p className="muted small">Bar height: sales per hour. Darker: more likely to sell before being undercut. Highlighted: best window.</p>
      <div className="days">
        {a.days.map((d, i) => (
          <div key={i} className="day" title={d.perDay == null ? "No data" : `${DAYS[i]}: ~${Math.round(d.perDay)} sales/day (${d.daysSeen.toFixed(1)} days of data)`}>
            <span className="lbl">{DAYS[i]}</span>
            <div className="track"><div className="bar" style={{ width: `${((d.perDay || 0) / maxDay) * 100}%` }} /></div>
            <span className="val">{d.perDay == null ? "—" : Math.round(d.perDay)}</span>
          </div>
        ))}
      </div>
      {(() => {
        const seen = a.days.map((d) => d.daysSeen).filter((x) => x > 0);
        const fewest = Math.min(...seen), most = Math.max(...seen);
        return <p className="muted small">Sales per day by weekday ({Math.floor(fewest)}–{Math.round(most)} of each weekday so far){fewest < 4 ? ", so treat these as rough; it gets more reliable as history builds up" : ""}.</p>;
      })()}
    </section>
  );
}
