import { useSyncExternalStore } from "react";
import { parseKinah } from "./metrics.js";

// localStorage with change notifications: components that read a key re-render when this tab writes it
// or another tab changes it. Every access is guarded: private windows and blocked storage throw.
const listeners = new Set();
const emit = (key) => { for (const l of listeners) l(key); };
if (typeof window !== "undefined") window.addEventListener("storage", (ev) => emit(ev.key));

export const KEYS = {
  budget: "a2dash.budget",          // your kinah, shared by both pages (never put in links)
  server: "a2dash.server",          // last server picked
  proficiency: "a2dash.proficiency", // { skill: 1-100 }
  planSettings: "a2dash.planSettings", // the plan's settings, last used on Market Analysis
  ledger: "a2ledger.v1",            // the Profit Calculator's log
  stoneValues: "a2dash.stoneValues", // { item key: kinah } for Lesser stones with no market price
};

/** Your values for Lesser stones that have no market price: { item key: kinah }. */
export function parseStoneValues(raw) {
  try {
    const v = JSON.parse(raw || "null") || {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => Number.isFinite(x) && x > 0).map(([k, x]) => [Number(k), x]));
  } catch { return {}; }
}

export function readRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
/** Write (or remove, for null) a key. Returns false if the browser wouldn't store it. */
export function writeRaw(key, value) {
  try {
    if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  } finally {
    emit(key);
  }
}
export function readJson(key) {
  try { return JSON.parse(readRaw(key) || "null"); } catch { return null; }
}

/** The raw string stored under `key`, kept current. */
export function useStoredRaw(key) {
  return useSyncExternalStore(
    (cb) => {
      const l = (k) => { if (k === key || k === null) cb(); };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => readRaw(key),
    () => null,
  );
}

/** Your kinah (null when not set). */
export function useKinah() {
  const raw = useStoredRaw(KEYS.budget);
  const v = parseKinah(raw);
  return Number.isFinite(v) ? v : null;
}
export function writeKinah(v) {
  return writeRaw(KEYS.budget, v == null ? null : String(Math.max(0, Math.round(v))));
}
