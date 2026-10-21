import { useEffect, useState } from "react";
import { shortenMarketNames } from "./metrics.js";

// Market data: the snapshot index plus one file per server, built by the GitHub Action. Both pages share one
// cache, so switching pages (or back to a server already seen) needs no new request.
export const SNAPSHOT_URL = "data/snapshot.json";
export const DEFAULT_SERVER = 11201; // Siel · Elyos · North America West

async function fetchJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-cache" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

let snapshotP = null;
export function loadSnapshot() {
  snapshotP ??= fetchJson(SNAPSHOT_URL).catch((e) => { snapshotP = null; throw e; });
  return snapshotP;
}

const serverP = new Map(); // server id -> promise of { generated_at, market }
const serverDone = new Map(); // server id -> loaded doc, for synchronous reads
export function prefetchServer(sid) {
  if (!serverP.has(sid)) {
    serverP.set(sid, fetchJson(`data/servers/${sid}.json`).then((doc) => {
      doc.market = shortenMarketNames(doc.market || { targets: [], items: [] });
      serverDone.set(sid, doc);
      return doc;
    }).catch((e) => { serverP.delete(sid); throw e; }));
  }
  return serverP.get(sid);
}

function loadServer(snapshot, sid) {
  // Older single-file snapshots carried every market inline; current ones have one file per server.
  const inline = snapshot.markets?.[String(sid)];
  if (inline && !serverDone.has(sid)) serverDone.set(sid, { generated_at: snapshot.generated_at, market: shortenMarketNames(inline) });
  if (serverDone.has(sid)) return Promise.resolve(serverDone.get(sid));
  return prefetchServer(sid);
}

export function serverLabel(srv) {
  return srv ? `${srv.name} · ${srv.faction} · ${srv.region_name || srv.region}` : "";
}

/** The snapshot index: { snapshot, error }. */
export function useSnapshot() {
  const [state, setState] = useState({ snapshot: null, error: null });
  useEffect(() => {
    let live = true;
    loadSnapshot().then((snapshot) => live && setState({ snapshot, error: null }), (error) => live && setState({ snapshot: null, error }));
    return () => { live = false; };
  }, []);
  return state;
}

/** One server's file: { doc, loading, error } for `sid` (the doc is null until it loads). */
export function useServerDoc(snapshot, sid) {
  const ready = snapshot && sid != null ? serverDone.get(sid) : null;
  const [state, setState] = useState({ sid: null, doc: null, error: null });
  useEffect(() => {
    if (!snapshot || sid == null) return;
    let live = true;
    loadServer(snapshot, sid).then((doc) => live && setState({ sid, doc, error: null }), (error) => live && setState({ sid, doc: null, error }));
    return () => { live = false; };
  }, [snapshot, sid]);
  if (ready) return { doc: ready, loading: false, error: null };
  if (state.sid === sid) return { doc: state.doc, loading: false, error: state.error };
  return { doc: null, loading: !!snapshot, error: null };
}
