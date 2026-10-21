import { useLayoutEffect, useRef, useState } from "react";
import { byRank, isWorthCrafting } from "../lib/metrics.js";
import { kinah, pct, rate } from "../lib/format.js";
import { ItemIcon } from "./ItemIcon.jsx";

// ----- tooltip -----
/** Tooltip state for the charts: returns [tip, handlers(row)]. */
export function useTip() {
  const [tip, setTip] = useState(null);
  const handlers = (row) => ({
    onMouseEnter: (e) => setTip({ row, x: e.clientX, y: e.clientY }),
    onMouseMove: (e) => setTip({ row, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setTip(null),
    onFocus: (e) => { const b = e.currentTarget.getBoundingClientRect(); setTip({ row, x: b.right, y: b.top }); },
    onBlur: () => setTip(null),
  });
  return [tip, handlers];
}

export function Tooltip({ tip, icons }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const pad = 14, w = ref.current.offsetWidth, h = ref.current.offsetHeight;
    let x = tip.x + pad, y = tip.y + pad;
    if (x + w > innerWidth - 8) x = tip.x - w - pad;
    if (y + h > innerHeight - 8) y = tip.y - h - pad;
    setPos({ left: Math.max(8, x), top: Math.max(8, y) });
  }, [tip]);
  if (!tip) return <div className="tooltip" role="status" hidden />;
  const r = tip.row;
  const line = (label, value) => <div className="row"><span>{label}</span><span>{value}</span></div>;
  return (
    <div className="tooltip" role="status" ref={ref} style={{ left: pos.left, top: pos.top }}>
      <strong className="tip-title"><ItemIcon icon={icons?.[r.key]} size="small" />{r.shortName}</strong>
      {line("Profit / craft", kinah(r.profit, { sign: true }))}
      {line("Margin", pct(r.marginPct))}
      {line("Capital needed", kinah(r.capital))}
      {line("Return on capital", pct(r.roc))}
      {line(`Sold / day${r.salesSource === "estimate" ? " (est.)" : ""}`, rate(r.perDay))}
      {line("Listings", r.listings)}
      {line("Daily pool", kinah(r.dailyPool))}
      {line("Turnover / day", kinah(r.turnover))}
      {line("Verdict", r.verdict.label)}
    </div>
  );
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

// True Dragon tiers may have no crafting cost; when nothing in view has one, show market size instead of profit.
export const noCostsInView = (rows) => rows.length > 0 && rows.every((r) => r.cost == null);

const Empty = ({ children }) => (
  <svg viewBox="0 0 560 120"><text className="empty" x="280" y="64" textAnchor="middle">{children}</text></svg>
);

export function BarChart({ rows, tipFor }) {
  const turnoverMode = noCostsInView(rows);
  const metric = turnoverMode ? "turnover" : "dailyPool";
  const data = rows.filter((r) => r[metric] != null && r[metric] > 0).sort((a, b) => b[metric] - a[metric]).slice(0, 10);
  if (!data.length) return <Empty>{turnoverMode ? "No sales estimates for these items yet." : "No craft is both profitable and selling with these settings."}</Empty>;
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
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${turnoverMode ? "Turnover per day" : "Expected daily profit"} by craft`}>
      <g className="grid">{ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={top} y2={H - bottom} />)}</g>
      {ticks.map((t) => <text key={t} className="axis-label" x={x(t)} y={H - 8} textAnchor="middle">{kinah(t)}</text>)}
      {data.map((d, i) => {
        const y = top + i * rowH + (rowH - barH) / 2;
        const w = Math.max(2, x(d[metric]) - left);
        return (
          <g className="row" key={d.key}>
            <text x={left - 10} y={y + barH / 2 + 4} textAnchor="end">{d.shortName}</text>
            <path className="bar" d={bar(left, y, w)} />
            <text className="value-label" x={left + w + 6} y={y + barH / 2 + 4}>{kinah(d[metric])}</text>
            <rect className="hit" tabIndex={0} x={0} y={top + i * rowH} width={W} height={rowH} {...tipFor(d)} />
          </g>
        );
      })}
    </svg>
  );
}

// Spread point labels vertically so none overlap.
function placeLabels(labels, minY, maxY, gap = 14) {
  const group = [...labels].sort((a, b) => a.cy - b.cy);
  group.forEach((l, i) => (l.ly = Math.max(l.cy, i ? group[i - 1].ly + gap : minY)));
  for (let i = group.length - 1; i >= 0; i--) {
    const limit = i === group.length - 1 ? maxY : group[i + 1].ly - gap;
    if (group[i].ly > limit) group[i].ly = limit;
  }
  return labels;
}

export function Scatter({ rows, tipFor }) {
  // Items with zero sales would sit on the x-axis and stretch it; the table still lists them.
  const data = rows.filter((r) => r.marginPct != null && r.perDay != null && r.perDay > 0);
  if (!data.length) {
    return <Empty>{rows.length && rows.every((r) => r.cost == null) ? "Margins need a crafting cost, which these tiers don't have yet." : "Not enough listing history yet to estimate sales."}</Empty>;
  }
  const W = 560, H = 330, left = 46, right = 16, top = 12, bottom = 40;
  const mins = Math.min(-10, ...data.map((d) => d.marginPct));
  const maxs = Math.max(10, ...data.map((d) => d.marginPct));
  const span = maxs - mins;
  const x0 = mins - span * 0.05, x1 = maxs + span * 0.05;
  const yTicks = niceTicks(Math.max(1, ...data.map((d) => d.perDay)));
  const y1 = yTicks[yTicks.length - 1];
  const x = (v) => left + ((v - x0) / (x1 - x0)) * (W - left - right);
  const y = (v) => top + (1 - v / y1) * (H - top - bottom);
  const step = niceTicks(x1 - x0, 5)[1] || 10;
  const xTicks = [];
  for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) xTicks.push(+v.toFixed(6));
  const labelled = new Set([...data].sort(byRank).slice(0, 5).map((d) => d.key));
  const labels = placeLabels(data.filter((d) => labelled.has(d.key)).map((d) => {
    const cx = x(d.marginPct), labelW = d.shortName.length * 6.3; // ~6.3px per character at 11.5px
    const anchor = cx + 10 + labelW > W - right ? "end" : "start";
    return { key: d.key, cx, cy: y(d.perDay), anchor, text: d.shortName };
  }), top + 8, H - bottom - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Margin versus units sold per day">
      <g className="grid">{yTicks.map((t) => <line key={t} x1={left} x2={W - right} y1={y(t)} y2={y(t)} />)}</g>
      {yTicks.map((t) => <text key={t} className="axis-label" x={left - 8} y={y(t) + 4} textAnchor="end">{rate(t)}</text>)}
      {xTicks.map((t) => <text key={t} className="axis-label" x={x(t)} y={H - bottom + 18} textAnchor="middle">{t}%</text>)}
      <line className="ref" x1={x(0)} x2={x(0)} y1={top} y2={H - bottom} />
      <text className="axis-label" x={W - right} y={H - 6} textAnchor="end">Margin →</text>
      <text className="axis-label" x={left} y={top - 2} textAnchor="start" dy="-2">Sold / day ↑</text>
      {data.map((d) => {
        const good = isWorthCrafting(d.verdict);
        return (
          <g key={d.key}>
            <circle className={`dot${good ? "" : " dim"}`} cx={x(d.marginPct)} cy={y(d.perDay)} r={good ? 6 : 5} />
            <circle className="hit" tabIndex={0} cx={x(d.marginPct)} cy={y(d.perDay)} r={13} {...tipFor(d)} />
          </g>
        );
      })}
      {labels.map((l) => {
        const tx = l.cx + (l.anchor === "end" ? -10 : 10);
        return (
          <g key={l.key}>
            {Math.abs(l.ly - l.cy) > 6 && <line className="ref" style={{ strokeDasharray: "none", opacity: 0.5 }} x1={l.cx} y1={l.cy} x2={tx - (l.anchor === "end" ? -2 : 2)} y2={l.ly} />}
            <text x={tx} y={l.ly + 4} textAnchor={l.anchor}>{l.text}</text>
          </g>
        );
      })}
    </svg>
  );
}
