import { useEffect, useId, useRef, type ReactNode } from "react";

export function StudioModal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);

  return (
    <div className="studio-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={`studio-modal${wide ? " studio-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="studio-modal-head">
          <h2 id={titleId} className="studio-modal-title">
            {title}
          </h2>
          <button type="button" className="btn-icon studio-modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="studio-modal-body">{children}</div>
      </div>
    </div>
  );
}
