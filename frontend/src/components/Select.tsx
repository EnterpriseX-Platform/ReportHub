"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export interface SelectOption { value: string; label: string; sub?: string }

export function Select({ value, onChange, options, placeholder = "— select —", disabled, style, searchable }: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Close on outside click (trigger + portal drop both excluded).
  useEffect(() => {
    function h(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || dropRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Recompute position after every open-state change so the portal always lands correctly.
  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, width: r.width });
    }
  }, [open]);

  function handleToggle() {
    setOpen((o) => !o);
    setQ("");
  }

  const current = options.find((o) => o.value === value);
  const list = q ? options.filter((o) => (o.label + " " + (o.sub ?? "")).toLowerCase().includes(q.toLowerCase()) || o.value.includes(q)) : options;

  return (
    <div style={{ position: "relative", ...style }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={handleToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          height: 38, width: "100%", display: "flex", alignItems: "center", gap: 8,
          padding: "0 10px 0 12px",
          border: `1.5px solid ${open ? "var(--accent)" : hover ? "var(--accent-line)" : "var(--line-strong)"}`,
          borderRadius: 9,
          background: open ? "var(--accent-weak)" : hover ? "var(--surface-2)" : "var(--surface)",
          fontFamily: "inherit",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          boxShadow: open ? "0 0 0 3px var(--accent-weak)" : "none",
          outline: "none",
          transition: "border-color .15s, background .12s, box-shadow .15s",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: current ? "var(--ink)" : "var(--ink-4)", fontSize: 13, textAlign: "left" }}>
          {current?.label ?? placeholder}
        </span>
        <Icon name="chevDown" size={14} style={{ color: open ? "var(--accent)" : "var(--ink-4)", flex: "none", transform: open ? "rotate(180deg)" : undefined, transition: ".2s" }} />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div ref={dropRef} className="menu" style={{
          position: "fixed", top: pos.top, left: pos.left, width: pos.width,
          maxHeight: 280, overflowY: "auto", zIndex: 9999,
          animation: "selDrop .13s cubic-bezier(.2,.8,.2,1)",
        }}>
          {(searchable || options.length > 8) && (
            <div style={{ padding: "6px 8px", position: "sticky", top: 0, background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
              <input className="input" autoFocus style={{ height: 30, fontSize: 12 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          {list.map((o) => (
            <div key={o.value} className={"menu-item" + (o.value === value ? " sel" : "")}
                 onClick={() => { onChange(o.value); setOpen(false); }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12.5 }}>{o.label}</span>
                {o.sub && <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 10.5, color: "var(--ink-4)", fontWeight: 400 }}>{o.sub}</span>}
              </span>
              {o.value === value && <Icon name="check" size={14} style={{ color: "var(--accent)" }} />}
            </div>
          ))}
          {list.length === 0 && <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--ink-4)" }}>No matches</div>}
        </div>,
        document.body,
      )}
      <style>{"@keyframes selDrop{from{transform:scale(.96) translateY(-4px);opacity:.4}to{transform:none;opacity:1}}"}</style>
    </div>
  );
}
