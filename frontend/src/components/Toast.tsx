"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

type Tone = "default" | "ok" | "error";
type Toast = { id: string; msg: string; tone: Tone };

const ToastCtx = createContext<(msg: string, tone?: Tone) => void>(() => {});

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((msg: string, tone: Tone = "default") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div style={{ position: "fixed", bottom: 22, right: 22, zIndex: 200, display: "flex", flexDirection: "column", gap: 10 }}>
        {toasts.map((t) => {
          const color = t.tone === "error" ? "var(--red)" : t.tone === "ok" ? "var(--green)" : "var(--accent)";
          return (
            <div
              key={t.id}
              className="fade-in"
              style={{
                display: "flex", alignItems: "center", gap: 10, background: "var(--surface)",
                border: "1px solid var(--line)", borderLeft: `3px solid ${color}`,
                boxShadow: "var(--shadow-lg)", borderRadius: 10, padding: "12px 16px",
                minWidth: 260, fontSize: 13, color: "var(--ink)",
              }}
            >
              <Icon name={t.tone === "error" ? "alert" : t.tone === "ok" ? "checkCircle" : "bolt"} size={17} style={{ color }} />
              {t.msg}
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
