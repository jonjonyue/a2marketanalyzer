// Number and time formatting shared by both pages.
export function kinah(v, { sign = false } = {}) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
  return s + Math.round(a);
}
export const full = (v) => (v == null ? "—" : (v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString("en-US"));
export const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + "%");
export const rate = (v) => (v == null ? "—" : v.toFixed(1));
export const days = (v) => (v == null ? "—" : v === Infinity ? "∞" : v >= 100 ? "99+" : v.toFixed(1));
export const signClass = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
export const asPct = (v) => `${(v * 100).toFixed(Math.abs(v * 100 - Math.round(v * 100)) > 0.05 ? 1 : 0)}%`; // 25%, 96.8%
export const cx = (...c) => c.filter(Boolean).join(" ");

export function ago(iso) {
  if (!iso) return "unknown";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
