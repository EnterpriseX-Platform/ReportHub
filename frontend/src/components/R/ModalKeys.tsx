"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Keyboard glue for forms inside a Modal.
 *
 * - Escape while a dropdown / combo box menu is open closes only that menu. Carbon's modal closes on a
 *   `document` keydown listener, and Next.js mounts React on `document` too, so stopping the React event
 *   is not enough: a native listener on this wrapper stops the key before it reaches `document`, and
 *   the menu is closed here by toggling its own button (the same as clicking it).
 * - Enter in a single-line input submits (`onSubmit`), like a native form. Textareas, buttons and
 *   open menus keep Enter for themselves.
 */
export function ModalKeys({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const submit = useRef(onSubmit);
  submit.current = onSubmit;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const box = t.closest?.(".cds--list-box--expanded");
      if (e.key === "Escape" && box) {
        e.stopPropagation();
        e.preventDefault();
        const toggle = box.querySelector<HTMLElement>("button[aria-haspopup]")
          ?? box.querySelector<HTMLElement>(".cds--list-box__menu-icon");
        toggle?.click();
        (box.querySelector<HTMLElement>("input, button[aria-haspopup]"))?.focus();
        return;
      }
      if (e.key === "Enter" && submit.current && !e.isComposing && t.tagName === "INPUT" && !t.closest(".cds--list-box")
          && !["checkbox", "radio", "button", "submit", "file"].includes((t as HTMLInputElement).type)) {
        e.preventDefault();
        e.stopPropagation();
        submit.current();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  return <div ref={ref}>{children}</div>;
}
