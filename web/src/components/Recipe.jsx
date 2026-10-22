import { masteryLabel, PROFICIENCY, shortenName } from "../lib/metrics.js";
import { kinah, asPct } from "../lib/format.js";
import { API } from "./ItemIcon.jsx";

// ---------- recipe breakdown (expanded table row), laid out the way the game (and questlog.gg) shows it ----------
// Each Artisan's Splendent item has aion2.exchange's cost chain: step 1 makes the Splendent item, step 2 the
// Expert's Splendent (consuming 1 Splendent per attempt), step 3 the Artisan's Splendent (consuming 1 Expert's).

export function itemUrl(key, tier) {
  // Artisan's Splendent items have a cost-breakdown page; everything else has an item page.
  return `${API}/${tier === "Artisan's Splendent" ? "crafts" : "items"}/${key}`;
}

export function ExtLink({ row, icon = false }) {
  const url = itemUrl(row.key, row.tier);
  const label = row.tier === "Artisan's Splendent" ? "crafting page" : "item page";
  return icon
    ? <a className="ext-link" href={url} target="_blank" rel="noopener" title={`Open the ${label} on aion2.exchange`} aria-label={`Open ${row.shortName} on aion2.exchange`}>↗</a>
    : <a className="ext-button" href={url} target="_blank" rel="noopener">Open {label} on aion2.exchange ↗</a>;
}

const MatLink = ({ id, name }) => <a href={`${API}/items/${id}`} target="_blank" rel="noopener" title="Open on aion2.exchange">{name}</a>;

const METHOD = { buy: "Bought", convert: "Converted", morph: "Converted", craft: "Crafted" };
function methodLabel(m) {
  const base = METHOD[m.method] || (m.method ? String(m.method) : "—");
  const via = (Array.isArray(m.via) ? m.via : [])
    .map((v) => (typeof v === "string" ? v : v?.name || v?.material_name || ""))
    .filter(Boolean);
  return via.length ? `${base} via ${via.join(", ")}` : base;
}

export function chainOf(chains, key) {
  for (const c of Object.values(chains || {})) {
    const i = (c.steps || []).findIndex((s) => s.result_key === key);
    if (i >= 0) return { chain: c, index: i };
  }
  return null;
}
const tierOf = (chain, key) => (chain.tiers || []).find((x) => x.item_key === key) || {};

const PriceCells = ({ market, crafted, used }) => <>
  <td className={used === "market" ? "used" : ""}>{kinah(market)}</td>
  <td className={used === "crafted" ? "used" : ""}>{crafted == null ? "—" : kinah(crafted)}</td>
</>;

/** One input row: { id, name, qty, market, crafted, used, method (node), cost }. */
const InputRow = ({ r }) => (
  <tr>
    <td><MatLink id={r.id} name={r.name} /></td><td>{r.qty}</td>
    <PriceCells market={r.market} crafted={r.crafted} used={r.used} />
    <td>{r.method}</td><td>{r.cost}</td>
  </tr>
);

const RecipeTable = ({ rows, perAttempt }) => (
  <table className="recipe">
    <thead><tr><th>Input</th><th>Qty</th><th>Market price</th><th>Crafted price</th><th>Used</th><th>Cost</th></tr></thead>
    <tbody>{rows.map((r, i) => <InputRow key={`${r.id}-${i}`} r={r} />)}</tbody>
    <tfoot><tr><td colSpan={5}>Per craft attempt</td><td>{kinah(perAttempt)}</td></tr></tfoot>
  </table>
);

// "96.8% success (cap)": the success rate used, marking when your level has reached the recipe's cap.
function successNote(rate, player, recipe) {
  const capped = player != null && recipe != null && player - recipe >= PROFICIENCY.fullDelta;
  return `${asPct(rate)} success${capped ? " (cap)" : ""}`;
}

const Crafted = () => <>Crafted <span className="muted">(below)</span></>;

// One card: the recipe that makes `steps[index]`'s result, with a nested card for the gear it consumes.
function StepCard({ chain, index, depth = 0 }) {
  const s = chain.steps[index];
  const prevStep = index > 0 ? chain.steps[index - 1] : null;
  const prev = prevStep ? tierOf(chain, prevStep.result_key) : null;
  const rows = [];
  let perAttempt = 0;
  const bought = s.gear_method === "buy";
  if (prevStep) {
    perAttempt += s.gear_cost ?? 0;
    rows.push({ id: prevStep.result_key, name: prevStep.result_name, qty: 1, market: prev.market_price, crafted: prev.cost,
      used: bought ? "market" : "crafted", method: bought ? "Bought" : <Crafted />, cost: kinah(s.gear_cost) });
  }
  for (const m of s.materials || []) {
    const cost = (m.unit_price ?? 0) * m.per_attempt;
    perAttempt += cost;
    const matBought = !m.method || m.method === "buy";
    rows.push({ id: m.material_key, name: m.name, qty: m.per_attempt, market: m.listing_price, crafted: matBought ? null : m.unit_price, used: matBought ? "market" : "crafted", method: methodLabel(m), cost: kinah(cost) });
  }
  const rate = (s.success_rate ?? 1) * (s.combo_probability ?? 1);
  const itemCost = tierOf(chain, s.result_key).cost ?? perAttempt / rate;
  if (s.success_rate === 0) {
    return (
      <div className="recipe-card">
        <RecipeTable rows={rows} perAttempt={perAttempt} />
        <p className="detail-sum">Needs <strong>{masteryLabel(s.mastery_level)}</strong> (you're {masteryLabel(s.player_level)}).</p>
      </div>
    );
  }
  return (
    <div className="recipe-card">
      <RecipeTable rows={rows} perAttempt={perAttempt} />
      <p className="detail-sum">
        {successNote(s.success_rate ?? 1, s.player_level, s.mastery_level)} × {asPct(s.combo_probability ?? 1)} combo → <strong>{kinah(itemCost)}</strong> each (~{(1 / rate).toFixed(1)} attempts).
      </p>
      {prevStep && (
        <details className="sub" open={depth < 1 && !bought}>
          <summary>How {prevStep.result_name} is made{bought ? " (bought: cheaper)" : ""}</summary>
          <StepCard chain={chain} index={index - 1} depth={depth + 1} />
        </details>
      )}
    </div>
  );
}

function TrueDragonCard({ row, chains }) {
  const d = row.costDetail;
  const rows = [{ id: d.baseKey, name: d.baseName, qty: 1, market: d.baseListing, crafted: d.baseCraft, used: d.baseMethod === "craft" ? "crafted" : "market",
    method: d.baseMethod === "craft" ? <Crafted /> : "Bought", cost: kinah(d.base) }];
  for (const m of d.materials) {
    rows.push({ id: m.key, name: m.name, qty: m.qty, market: m.price, crafted: null, used: "market", method: "Bought", cost: m.price == null ? "—" : kinah(m.price * m.qty) });
  }
  const combo = Math.round(d.comboProbability * 100);
  const sn = successNote(d.success, d.playerLevel, d.recipeLevel);
  const base = chainOf(chains, d.baseKey);
  return <>
    <div className="recipe-card">
      <RecipeTable rows={rows} perAttempt={d.attempt} />
      {d.success === 0
        ? <p className="detail-sum">Needs <strong>{masteryLabel(d.recipeLevel)}</strong> (you're {masteryLabel(d.playerLevel)}).</p>
        : d.isCombo
          ? <p className="detail-sum">{sn} × {combo}% combo → <strong>{kinah(row.cost)}</strong> each.</p>
          : <p className="detail-sum">{sn} → <strong>{kinah(row.cost)}</strong> each.</p>}
      {base && (
        <details className="sub" open>
          <summary>How {d.baseName} is made</summary>
          <StepCard chain={base.chain} index={base.index} depth={1} />
        </details>
      )}
    </div>
    <TransferCard row={row} />
  </>;
}

// The bound transfer route for Splendent True Dragon: not a way to make one to sell, but what buyers can pay instead.
function TransferCard({ row }) {
  const t = row.transfer;
  if (!t) return null;
  const rows = [{ id: t.tdKey, name: shortenName(t.tdName), qty: 1, market: t.tdListing, crafted: t.tdCraft, used: t.tdMethod === "craft" ? "crafted" : "market",
    method: t.tdMethod === "craft" ? "Crafted" : "Bought", cost: kinah(t.td) }];
  for (const m of t.materials) {
    rows.push({ id: m.key, name: m.name, qty: m.qty, market: m.price, crafted: null, used: "market", method: "Bought", cost: m.price == null ? "—" : kinah(m.price * m.qty) });
  }
  const vs = t.cost == null || row.price == null ? null
    : row.price > t.cost
      ? <> <strong>{kinah(row.price - t.cost)} under</strong> this item's sell price, which caps what it can sell for.</>
      : null;
  return (
    <details className="sub transfer" open>
      <summary>Alternative: transfer craft (bound, can't be sold)</summary>
      <p className="muted small">What a buyer could pay to make their own instead.</p>
      <div className="recipe-card">
        <RecipeTable rows={rows} perAttempt={t.attempt} />
        {t.cost == null
          ? <p className="detail-sum">An input has no price on this server.</p>
          : <p className="detail-sum">{asPct(t.success)} success → <strong>{kinah(t.cost)}</strong> each.{vs}</p>}
      </div>
    </details>
  );
}

export function RecipeDetail({ row, chains }) {
  const c = row.costDetail ? null : chainOf(chains, row.key);
  return <>
    <div className="detail-head">
      <div>
        <h3>How {row.shortName} is made</h3>
        <p className="muted">{row.skill} · cost per item {kinah(row.cost)}{row.listing != null ? ` · cheapest listing ${kinah(row.listing)}` : ""}</p>
      </div>
      <ExtLink row={row} />
    </div>
    {row.costDetail ? <TrueDragonCard row={row} chains={chains} />
      : c ? <StepCard chain={c.chain} index={c.index} />
        : <p className="muted">No recipe available for this item.</p>}
    {(row.costDetail || c) && (
      <p className="muted small">Highlighted price is the one used.</p>
    )}
  </>;
}
