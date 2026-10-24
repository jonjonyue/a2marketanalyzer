import { Method } from "../components/Method.jsx";

// The "How this is calculated" notes for the Profit Calculator.
export function LedgerMethod() {
  return (
    <Method summary={<>
      <ul>
        <li>Sales lose the 10% tax and 2% listing fee (a listing pays the fee once, when posted); purchases cost the full price.</li>
        <li><strong>Relist at</strong> suggests a price for when a listing expires (or to cancel and repost), from today's market and recent sales. <em>Relist</em> uses it.</li>
        <li>Your kinah moves with every entry. Entries stay in this browser, so export a backup.</li>
      </ul>
    </>}>
      <ul>
        <li><strong>Sold</strong>: you receive price × quantity, minus the sales tax (default 10%) and the listing fee (default 2%). Enter the price you listed it at; the deductions are worked out per entry and rounded to the nearest kinah.</li>
        <li><strong>Bought</strong>: you pay price × quantity. The buyer pays no tax on the exchange.</li>
        <li><strong>Materials</strong> (first in the item list) is a catch-all for anything you bought to craft with. Log it as Bought, either as one entry with quantity 1 and the total you spent, or per material. It counts against your profit like any purchase, and shows as "Crafting materials" in the by-item table.</li>
        <li><strong>Listed</strong>: posting a listing costs the listing fee (default 2% of price × quantity) right away, whether or not it sells. It then shows under Active listings, where you can mark some or all of it sold (each sale deducts only the sales tax, since the fee was already paid), mark it expired (the fee is lost), or relist the unsold units (a new listing with a new fee). Listings expire after 3 days. Use <em>Sold</em> directly for sales you didn't log as a listing; those deduct both tax and fee.</li>
        <li><strong>Relist at</strong>: if you're still the cheapest listing, keep your price, unless recent sales are below it (then drop to them) or yours is the only listing and recent sales are higher (then raise toward them). If you've been undercut, it's the same List at price the craft plan uses: just under the competition, at the usual sale price where undercutters are active, never above what recent sales support and never below your break-even (crafting cost ÷ what's left after tax and fee). Recent sales count more than older ones (weight halves every 36 hours), and the hover shows the trend: the recent usual price vs the week's. Relisting costs a new listing fee, so lowering is only worth it when the listing would otherwise sit unsold.</li>
        <li><strong>Profit</strong> = everything received from sales − everything spent buying − listing fees paid, within the selected period. Items you bought but haven't sold yet count against you until you sell them; "On hand" shows how many are still unsold.</li>
        <li><strong>Your kinah</strong> is the same amount as on the Market Analysis page, where it sizes the "what to craft" plan. Once it's set, every entry moves it: a purchase takes the price paid, a listing takes its fee, a sale adds what you receive after tax, and editing, deleting or undoing an entry reverses its effect. Importing a backup doesn't change it, since that history is already in your balance. You can correct it by typing a new amount at any time.</li>
        <li>Prices accept shorthand: <code>250k</code>, <code>1.5m</code>, <code>2b</code>, or plain numbers with commas.</li>
      </ul>
    </Method>
  );
}
