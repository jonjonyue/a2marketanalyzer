import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App.jsx";
import { loadSnapshot, prefetchServer, DEFAULT_SERVER } from "./lib/data.js";
import { KEYS, readRaw } from "./lib/storage.js";

// Start the data requests before React renders: the index, and the server this visit will most likely show.
loadSnapshot().catch(() => {});
{
  const p = new URLSearchParams(location.search);
  const sid = location.hash.startsWith("#/ledger") ? parseInt(readRaw(KEYS.server), 10)
    : parseInt(p.get("server") ?? readRaw(KEYS.server), 10);
  prefetchServer(Number.isInteger(sid) ? sid : DEFAULT_SERVER).catch(() => {});
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
