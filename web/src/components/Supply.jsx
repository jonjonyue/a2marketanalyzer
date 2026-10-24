import { rate } from "../lib/format.js";
import { ItemIcon } from "./ItemIcon.jsx";

// Crafters entering a market (metrics.supplyInflux): a tag for item cells, and the "New supply" panel.

const usual = (x) => (x.newPerDayBefore < 0.5 ? "almost none" : `~${rate(x.newPerDayBefore)}/day`);
export const influxTitle = (x) =>
  `${x.newRecent} new listings in the last 24h (usually ${usual(x)}); listed ${x.listedDayAgo ?? "?"} → ${x.listedNow}; ${x.soldRecent} sold in 24h`;

export function SupplyTag({ influx }) {
  if (!influx) return null;
  return <span className={`supply-tag ${influx.level}`} title={influxTitle(influx)}>{influx.level === "flood" ? "▲▲ flooding" : "▲ new supply"}</span>;
}

/** rows: analyzed crafts (whole server); mine: Map key -> units you have listed; planned: Map key -> units in the plan. */
export function SupplyPanel({ rows, mine, planned, icons }) {
  const list = rows.filter((r) => r.influx).map((r) => ({ r, mine: mine.get(r.key) || 0, planned: planned.get(r.key) || 0 }))
    .sort((a, b) => (b.mine + b.planned > 0) - (a.mine + a.planned > 0) || (b.r.influx.level === "flood") - (a.r.influx.level === "flood") || b.r.influx.ratio - a.r.influx.ratio);
  const hits = list.filter((x) => x.mine || x.planned).length;
  return (
    <section className="panel table-panel supply-panel" aria-labelledby="supplyTitle">
      <div className="table-head">
        <h2 id="supplyTitle">New supply</h2>
        <p className="muted">{list.length ? `${list.length} item${list.length > 1 ? "s" : ""} with crafters piling in over the last 24h${hits ? ` · ${hits} you're in` : ""}` : "No unusual new supply in the last 24h."}</p>
      </div>
      {list.length > 0 && (
        <div className="table-scroll">
          <table className="ledger-table supply-table">
            <thead><tr><th>Item</th><th>New 24h</th><th>Usual</th><th>Listed</th><th>Sold 24h</th><th>You</th></tr></thead>
            <tbody>
              {list.map(({ r, mine: m, planned: p }) => (
                <tr key={r.key} className={m || p ? "yours" : undefined}>
                  <td className="name"><span className="item-cell"><ItemIcon icon={icons[r.key]} size="small" /><span>{r.shortName}</span> <SupplyTag influx={r.influx} /></span></td>
                  <td><strong>{r.influx.newRecent}</strong></td>
                  <td className="dim">{usual(r.influx)}</td>
                  <td>{r.influx.listedDayAgo ?? "?"} → <strong>{r.influx.listedNow}</strong></td>
                  <td>{r.influx.soldRecent}</td>
                  <td>{[m && `${m} listed`, p && `${p} in plan`].filter(Boolean).join(" · ") || <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
