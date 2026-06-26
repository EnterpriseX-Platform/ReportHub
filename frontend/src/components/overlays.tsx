"use client";

import type { ReactNode } from "react";
import { Icon } from "./Icon";

export function Modal({
  title,
  sub,
  onClose,
  children,
  foot,
  width,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  width?: number;
}) {
  return (
    <div className="modal-wrap" onMouseDown={onClose}>
      <div className="modal" style={width ? { width } : {}} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "18px 22px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
            {sub && <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>{children}</div>
        {foot && <div className="so-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function SlideOver({
  title,
  sub,
  badge,
  onClose,
  children,
  foot,
}: {
  title: string;
  sub?: string;
  badge?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="slideover" onMouseDown={(e) => e.stopPropagation()}>
        <div className="so-head">
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
              {badge}
            </div>
            {sub && <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 4 }}>{sub}</div>}
          </div>
          <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="so-body">{children}</div>
        {foot && <div className="so-foot">{foot}</div>}
      </div>
    </div>
  );
}
