"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ToastNotification } from "@carbon/react";

type Tone = "default" | "ok" | "error" | "warning";
type Toast = { id: string; msg: string; tone: Tone };

const KIND = { default: "info", ok: "success", error: "error", warning: "warning" } as const;

const ToastCtx = createContext<(msg: string, tone?: Tone) => void>(() => {});

/**
 * Carbon ToastNotification stack, top-right just below the header (bottom-right covered side-panel footers). API unchanged: `const toast = useToast(); toast("Saved", "ok")`.
 * Toasts auto-dismiss (errors stay longer) and can be closed with their own close button.
 */
export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const close = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((msg: string, tone: Tone = "default") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, msg, tone }]);
    setTimeout(() => close(id), tone === "error" ? 8000 : 4000);
  }, [close]);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="rh-toasts" aria-live="polite" style={{ top: "calc(3rem + 0.5rem)", bottom: "auto" }}>
        {toasts.map((t) => (
          <ToastNotification
            key={t.id}
            kind={KIND[t.tone]}
            title={t.msg}
            lowContrast={false}
            onClose={() => { close(t.id); return false; }}
          />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
