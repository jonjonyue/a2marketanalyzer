import { useEffect, useState } from "react";

/** A toast with an optional undo: returns [element, show(msg, undo?)]. */
export function useToast() {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const show = (msg, undo) => setToast({ msg, undo, id: Date.now() });
  const el = (
    <div className="toast" role="status" hidden={!toast}>
      {toast && <>
        <span>{toast.msg}</span>
        {toast.undo && <button type="button" onClick={() => { toast.undo(); setToast(null); }}>Undo</button>}
      </>}
    </div>
  );
  return [el, show];
}
