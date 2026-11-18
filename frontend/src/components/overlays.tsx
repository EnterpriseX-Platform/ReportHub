"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ComposedModal, IconButton, Layer, ModalBody, ModalFooter, ModalHeader } from "@carbon/react";
import { Close } from "@carbon/icons-react";

/**
 * Stack of open overlays (modals and side panels), newest last. Escape closes only the top one:
 * Carbon closes the topmost modal itself, so a side panel ignores Escape while anything sits above it.
 */
const overlayStack: object[] = [];
function useOverlayToken(): object {
  const ref = useRef<object>({});
  useEffect(() => {
    const t = ref.current;
    overlayStack.push(t);
    return () => { const i = overlayStack.lastIndexOf(t); if (i >= 0) overlayStack.splice(i, 1); };
  }, []);
  return ref.current;
}
const isTopOverlay = (t: object) => overlayStack[overlayStack.length - 1] === t;
/** True while any modal or side panel is open — page-level Escape handlers should then stand down. */
export const anyOverlayOpen = () => overlayStack.length > 0;

/** Width (px, legacy prop) → Carbon modal size. */
function sizeOf(width?: number): "xs" | "sm" | "md" | "lg" {
  if (!width) return "md";
  if (width <= 400) return "xs";
  if (width <= 560) return "sm";
  if (width <= 800) return "md";
  return "lg";
}

/**
 * Enter in a single-line field submits the dialog: clicks the footer's primary (or danger) button
 * when there is exactly that action and it is enabled. Textareas, editors, menus and buttons keep Enter.
 */
function submitOnEnter(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || e.defaultPrevented) return;
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLInputElement)) return;
  if (["checkbox", "radio", "button", "submit", "file"].includes(t.type)) return;
  if (t.getAttribute("role") === "combobox" || t.closest("[role='listbox'], [role='menu'], .cm-editor")) return;
  const foot = e.currentTarget.querySelector(".cds--modal-footer");
  const btn = foot?.querySelector<HTMLButtonElement>("button.cds--btn--primary, button.cds--btn--danger");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  btn.click();
}

/**
 * Carbon ComposedModal. Same props as before: title, sub (shown as the small label above the title),
 * foot (Carbon buttons; they fill the footer), width (mapped to xs/sm/md/lg), onClose.
 * Always mounted open — callers render it conditionally, as they did before.
 */
export function Modal({ title, sub, onClose, children, foot, width, danger }: {
  title: string; sub?: string; onClose: () => void; children: ReactNode; foot?: ReactNode; width?: number;
  /** Red top accent for destructive confirmations. */
  danger?: boolean;
}) {
  useOverlayToken();
  return (
    <ComposedModal open size={sizeOf(width)} onClose={() => { onClose(); return false; }} danger={danger}
                   preventCloseOnClickOutside={false} selectorPrimaryFocus="input, [data-modal-primary-focus]"
                   onKeyDown={submitOnEnter}>
      <ModalHeader label={sub} title={title} />
      <ModalBody hasForm>{children}</ModalBody>
      {foot && <ModalFooter>{foot}</ModalFooter>}
    </ComposedModal>
  );
}

/**
 * Side panel (Carbon "side panel" pattern built from core pieces: Carbon has no side panel in
 * @carbon/react). Slides in from the right under the 48px UI-shell header, layer-01 surface,
 * Escape / overlay click / close button close it. Footer buttons fill the 64px footer like a modal's.
 */
export function SlideOver({ title, sub, badge, onClose, children, foot, width = 560 }: {
  title: string; sub?: string; badge?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode;
  /** Panel width in px on wide screens (always full width on phones). */
  width?: number;
}) {
  const token = useOverlayToken();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !isTopOverlay(token)) return;
      onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, token]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="rh-sidepanel-overlay" onMouseDown={onClose}>
      <aside className="rh-sidepanel" role="dialog" aria-label={title} style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <header className="rh-sidepanel__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h2 className="cds--type-heading-03 rh-sidepanel__title">{title}</h2>
              {badge}
            </div>
            {sub && <div className="cds--type-label-01 rh-dim" style={{ marginTop: 4 }}>{sub}</div>}
          </div>
          <IconButton kind="ghost" size="md" label="Close" align="left" onClick={onClose}><Close size={20} /></IconButton>
        </header>
        <Layer className="rh-sidepanel__body">{children}</Layer>
        {foot && <footer className="rh-sidepanel__foot cds--modal-footer">{foot}</footer>}
      </aside>
    </div>,
    document.body,
  );
}
