import { useState } from "react";

/** "How this is calculated": a short summary that expands to the full notes when clicked. */
export function Method({ summary, children }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`panel method${open ? " open" : ""}`}>
      <button type="button" className="method-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <h2>How this is calculated</h2>
        <span className="method-more">{open ? "Show less ▴" : "Full details ▾"}</span>
      </button>
      {open ? children : summary}
    </section>
  );
}
