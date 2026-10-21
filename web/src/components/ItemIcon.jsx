import { useState } from "react";

export const API = "https://aion2.exchange";

/** Item icon from aion2.exchange's icon set, framed in the item's rarity color. Cosmetic: hidden if it fails to load. */
export function ItemIcon({ icon, size = "" }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) return null;
  const [file, color, rarity] = icon;
  const style = /^#[0-9a-f]{6}$/i.test(color || "") ? { "--rarity": color } : undefined;
  return (
    <img className={`item-icon ${size}`.trim()} src={`${API}/item-icons/${encodeURIComponent(file)}.webp`} alt="" style={style}
      title={rarity || ""} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  );
}
