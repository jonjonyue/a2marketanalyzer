import { useEffect, useState } from "react";
import Market from "./pages/Market.jsx";
import Ledger from "./pages/Ledger.jsx";

// One page with two tabs. The tab lives in the hash (#/ledger), so switching tabs never reloads the page or
// the market data, and Market Analysis keeps its settings in the query string as before.
const pageOf = (hash) => (hash.startsWith("#/ledger") ? "ledger" : "market");
const TITLES = { market: "Aion 2 Crafting Profit", ledger: "Aion 2 Profit Calculator" };

export default function App() {
  const [page, setPage] = useState(() => pageOf(location.hash));
  useEffect(() => {
    const f = () => setPage(pageOf(location.hash));
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  useEffect(() => { document.title = TITLES[page]; window.scrollTo(0, 0); }, [page]);
  return <>
    <nav className="nav" aria-label="Pages">
      <div className="wrap nav-inner">
        <a className="brand" href="#/"><span className="brand-mark" aria-hidden="true">◆</span>A2 Market</a>
        <div className="nav-links">
          <a href="#/" aria-current={page === "market" ? "page" : undefined}>Market Analysis</a>
          <a href="#/ledger" aria-current={page === "ledger" ? "page" : undefined}>Profit Calculator</a>
        </div>
      </div>
    </nav>
    {page === "ledger" ? <Ledger /> : <Market />}
  </>;
}
