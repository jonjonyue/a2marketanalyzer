import { createContext, useContext } from "react";
import { KEYS, readRaw, useStoredRaw, writeRaw } from "../lib/storage.js";

// Collapsible panels. Each panel has an id; the ids of the collapsed ones are saved in this browser
// (KEYS.folded, a JSON array) so a panel stays collapsed across visits and on both pages.

const parse = (raw) => {
  try { const v = JSON.parse(raw || "[]"); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
};

/** Collapse (true) or expand (false) panel `id`. */
export function setFolded(id, folded) {
  const set = parse(readRaw(KEYS.folded));
  if (folded === set.has(id)) return;
  if (folded) set.add(id); else set.delete(id);
  writeRaw(KEYS.folded, set.size ? JSON.stringify([...set]) : null);
}

const FoldContext = createContext(null);

/**
 * A panel that collapses to one line: its title. `as` is the element (section, figure, form); other props go on it.
 * Put <FoldTitle> where the title goes when it's open.
 */
export function Fold({ id, title, titleId, as: Tag = "section", className = "", children, ...rest }) {
  const folded = parse(useStoredRaw(KEYS.folded)).has(id);
  const toggle = () => setFolded(id, !folded);
  if (folded) {
    // Only the title: no controls, notes or content. aria-labelledby on the panel still finds the title's id.
    return (
      <Tag className={`${className} folded`} data-fold={id} {...rest}>
        <h2 id={titleId} className="fold-title"><FoldButton folded onClick={toggle}>{title}</FoldButton></h2>
      </Tag>
    );
  }
  return (
    <FoldContext.Provider value={{ toggle }}>
      <Tag className={className} data-fold={id} {...rest}>{children}</Tag>
    </FoldContext.Provider>
  );
}

/** The open panel's title, with the button that collapses it. Takes the h2's props (id). */
export function FoldTitle({ children, ...rest }) {
  const ctx = useContext(FoldContext);
  return <h2 className="fold-title" {...rest}><FoldButton folded={false} onClick={ctx?.toggle}>{children}</FoldButton></h2>;
}

function FoldButton({ folded, onClick, children }) {
  return (
    <button type="button" className="fold-btn" aria-expanded={!folded} onClick={onClick} title={folded ? "Show this section" : "Collapse this section"}>
      <span className="fold-chev" aria-hidden="true">{folded ? "▸" : "▾"}</span>{children}
    </button>
  );
}
