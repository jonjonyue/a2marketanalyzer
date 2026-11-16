import { createContext, useContext, useState } from "react";
import { MATERIAL_SIGNALS, windowLabel } from "../lib/materials.js";
import { kinah } from "../lib/format.js";
import { Fold, FoldTitle } from "./Fold.jsx";
import { ItemIcon, API } from "./ItemIcon.jsx";

// "Materials: stock up?" on Market Analysis, plus the signal tags in recipe panels (MaterialTag).

const pctText = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 100))}%`;

/** Map of material key -> analyzed material, for the recipe panels' tags. */
export const MaterialSignals = createContext(null);

/** A small tag next to a material in a recipe: "▾ 40% under usual" when it's worth noticing, otherwise nothing. */
export function MaterialTag({ id }) {
  const m = useContext(MaterialSignals)?.get(Number(id));
  if (!m || m.signal === "normal") return null;
  const under = m.vs < 0;
  return (
    <span className={`mat-tag ${m.signal}`} title={`${MATERIAL_SIGNALS[m.signal].label}: ${advice(m)}`}>
      {under ? "▾" : "▴"} {Math.abs(Math.round(m.vs * 100))}% {under ? "under" : "over"} usual
    </span>
  );
}

function advice(m) {
  const d = Math.round(m.days);
  const vs = `${pctText(m.vs)} against its ${d}-day usual ${kinah(m.usual)}`;
  const recent = Math.abs(m.shift) >= 0.05 ? ` The last 3 days have run ${pctText(m.shift)} against that usual (around ${kinah(m.recent)}).` : "";
  switch (m.signal) {
    case "buy":
      return `${vs}, cheaper than ${100 - m.pct}% of the last ${d} days.${recent} ${m.falling ? "Still falling, so buy part now and the rest in a day or two." : "A good time to buy ahead."}`;
    case "cheap":
      return m.vs > -0.05 && m.vsRecent <= -0.1
        ? `${pctText(m.vsRecent)} under its level of the last 3 days (${kinah(m.recent)}), which has risen lately. A dip worth buying into.`
        : `${vs}.${recent} Worth buying what you'll need soon.`;
    case "dropping":
      return `${vs}, but the whole market has moved down lately.${recent} The two-week usual may be out of date, and it could keep falling: buy what you need, not ahead.`;
    case "pricey":
      return `${vs}, near the top of its range.${recent}${m.shift >= 0.15 ? " It has been climbing, so this may be its new level." : ""} Buy only what you need now.`;
    default:
      return m.listed ? `${vs}. No reason to buy ahead.` : "Nothing listed right now.";
  }
}

function Spark({ values, w = 112, h = 28 }) {
  if (!values?.length) return null;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * w, h - 3 - ((v - lo) / span) * (h - 6)]);
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="mat-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" ")} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="2.5" fill="var(--text)" />
    </svg>
  );
}

function BigChart({ m }) {
  const w = 560, h = 150, pad = 34, vals = m.spark;
  const lo = Math.min(...vals, m.usual), hi = Math.max(...vals, m.usual), span = hi - lo || 1;
  const x = (i) => pad + (i / Math.max(1, vals.length - 1)) * (w - pad - 8);
  const y = (v) => 8 + (1 - (v - lo) / span) * (h - 28);
  const d = Math.round(m.days);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={`${m.name}: cheapest price over the last ${d} days`}>
      <line x1={pad} x2={w - 8} y1={y(m.usual)} y2={y(m.usual)} stroke="var(--muted)" strokeDasharray="3 3" />
      <text x={w - 8} y={y(m.usual) - 4} fontSize="10" fill="var(--muted)" textAnchor="end">usual {kinah(m.usual)}</text>
      <text x="2" y={y(hi) + 4} fontSize="10" fill="var(--muted)">{kinah(hi)}</text>
      <text x="2" y={y(lo) + 4} fontSize="10" fill="var(--muted)">{kinah(lo)}</text>
      <polyline points={vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(vals.length - 1)} cy={y(vals[vals.length - 1])} r="3.5" fill="var(--text)" />
      <text x={pad} y={h - 4} fontSize="10" fill="var(--muted)">{d}d ago</text>
      <text x={w - 8} y={h - 4} fontSize="10" fill="var(--muted)" textAnchor="end">now</text>
    </svg>
  );
}

function Windows({ m }) {
  const vals = m.byWindow.map((v) => v ?? 0);
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0), span = hi - lo || 1;
  return (
    <>
      <div className="mat-hours" role="img" aria-label={`Price against usual by time of day; cheapest ${windowLabel(m.bestWindow)}`}>
        {m.byWindow.map((v, i) => (
          <div key={i} className={i === m.bestWindow ? "best" : ""} title={v == null ? "Not enough data" : `${windowLabel(i)}: ${pctText(v)} against usual`}
            style={{ height: `${v == null ? 4 : 12 + ((hi - v) / span) * 88}%` }} />
        ))}
      </div>
      <div className="mat-hours-l">{m.byWindow.map((_, i) => <span key={i}>{windowLabel(i).replace(/am|pm/g, (s) => s[0])}</span>)}</div>
    </>
  );
}

export function MaterialsPanel({ materials, icons }) {
  const [filter, setFilter] = useState("act");
  const [open, setOpen] = useState(null);
  if (!materials?.length) return null;
  const n = (s) => materials.filter((m) => m.signal === s).length;
  const shown = materials.filter((m) => (filter === "all" ? true : filter === "base" ? m.base : m.signal !== "normal"));
  const d = Math.round(Math.max(...materials.map((m) => m.days)));
  const dips = materials.filter((m) => m.signal === "buy").slice(0, 3).map((m) => `${m.name} (${pctText(m.vs)})`);
  return (
    <Fold id="materials" title="Materials: stock up?" titleId="matTitle" className="panel table-panel materials-panel" aria-labelledby="matTitle">
      <div className="table-head">
        <FoldTitle id="matTitle">Materials: stock up?</FoldTitle>
        <div className="seg mat-filter" role="radiogroup" aria-label="Show">
          {[["act", "Worth a look"], ["base", "Base materials"], ["all", "All"]].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      </div>
      <p className="muted mat-sum">
        {n("buy")} to stock up on, {n("cheap")} cheap, {n("dropping")} dropping, {n("pricey")} pricey, of {materials.length} materials over the last {d} days.
        {dips.length > 0 && <> Biggest dips: {dips.join(", ")}.</>}
      </p>
      <div className="table-scroll">
        <table className="mat-table">
          <thead><tr>
            <th>Material</th><th>Signal</th><th className="num">Now</th><th className="num">Usual</th><th className="num">vs usual</th>
            <th className="mat-wide">{d}-day range</th><th className="mat-wide">Trend</th><th className="mat-wide">Cheapest around</th><th className="mat-wide">Used in</th>
          </tr></thead>
          <tbody>
            {shown.map((m) => {
              const isOpen = open === m.key;
              return [
                <tr key={m.key} className={`mat-row${isOpen ? " open" : ""}`} onClick={() => setOpen(isOpen ? null : m.key)}>
                  <td className="name">
                    <button type="button" className="mat-toggle" aria-expanded={isOpen}>
                      <span className="item-cell"><ItemIcon icon={icons?.[m.key]} /><span>{m.name}</span></span>
                    </button>
                    {m.base && <span className="base-tag" title="Base material: gathered or dropped, refined into what crafts use">base</span>}
                  </td>
                  <td>
                    <span className={`pill mat-${m.signal}`}>{MATERIAL_SIGNALS[m.signal].label}</span>
                    {m.falling && m.vs < 0 && <span className="mat-note down">↘ still falling</span>}
                    {Math.abs(m.shift) >= 0.15 && <span className="mat-note" title={`The last 3 days have run ${pctText(m.shift)} against the ${d}-day usual`}>{m.shift < 0 ? "↓" : "↑"} {pctText(m.shift)} lately</span>}
                  </td>
                  <td className="num"><strong>{m.listed ? kinah(m.price) : "—"}</strong></td>
                  <td className="num muted">{kinah(m.usual)}</td>
                  <td className={`num ${m.vs < 0 ? "pos" : m.vs > 0 ? "neg" : ""}`}>{pctText(m.vs)}</td>
                  <td className="mat-wide">
                    <div className="mat-range" title={`${d}-day low ${kinah(m.lo)}, high ${kinah(m.hi)}; now cheaper than ${100 - m.pct}% of the period`}>
                      <div className="bar" /><div className="dot" style={{ left: `${m.pct}%` }} />
                    </div>
                  </td>
                  <td className="mat-wide"><Spark values={m.spark} /></td>
                  <td className="mat-wide small">{m.bestWindow != null ? <>{windowLabel(m.bestWindow)} <span className="muted">{pctText(m.byWindow[m.bestWindow])}</span></> : "—"}</td>
                  <td className="mat-wide mat-uses">{m.uses.slice(0, 2).join(", ")}{m.uses.length > 2 && <span className="muted" title={m.uses.join("\n")}> +{m.uses.length - 2} more</span>}</td>
                </tr>,
                isOpen && (
                  <tr key={`${m.key}-d`} className="mat-detail"><td colSpan={9}>
                    <div className="mat-det">
                      <div>
                        <h3>Cheapest listing, last {Math.round(m.days)} days</h3>
                        <BigChart m={m} />
                        <p>{advice(m)}</p>
                        <p className="muted small">Used in: {m.uses.join(", ")} · <a href={`${API}/items/${m.key}`} target="_blank" rel="noopener">Open on aion2.exchange ↗</a></p>
                      </div>
                      <div>
                        <h3>By time of day (your time)</h3>
                        <Windows m={m} />
                        {m.bestWindow != null && <p className="muted small">Cheapest around {windowLabel(m.bestWindow)}, typically {pctText(m.byWindow[m.bestWindow])} against usual{Math.abs(m.byWindow[m.bestWindow]) < 0.03 ? ", so timing barely matters here" : ""}.</p>}
                      </div>
                    </div>
                  </td></tr>
                ),
              ];
            })}
            {!shown.length && <tr><td colSpan={9} className="muted">Nothing unusual right now: every material is close to its usual price.</td></tr>}
          </tbody>
        </table>
      </div>
      <details className="mat-rules">
        <summary>How the signal works</summary>
        <ul>
          <li><strong>Usual</strong> is the median cheapest listing over the last {d} days (hourly). Materials from NPCs and ones you craft or convert yourself aren't listed. Listings don't show quantities, so this doesn't say how many to buy.</li>
          <li><strong>Stock up</strong>: in its cheapest 20% of the period and 10%+ under usual. <strong>Cheap</strong>: cheapest 35% and 5%+ under, or 10%+ under a level that has risen over the last 3 days. <strong>Pricey</strong>: priciest 20% and 10%+ over.</li>
          <li><strong>Dropping</strong>: cheap against the two weeks, but the last 3 days have run 15%+ under them, so the market has moved and may keep falling. <strong>↓/↑ lately</strong> marks that kind of shift either way.</li>
          <li><strong>Still falling</strong>: the last day ran 8%+ under the two days before.</li>
        </ul>
      </details>
    </Fold>
  );
}
