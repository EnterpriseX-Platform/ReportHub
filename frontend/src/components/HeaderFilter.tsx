"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, IconButton, Search, SkeletonText, TextInput } from "@carbon/react";
import { Filter, FilterEdit, Renew } from "@carbon/icons-react";
import styles from "./D/HeaderFilter.module.scss";

/** Filter for one column — picked values and/or a contains term (when both are set, a row must match both) */
export interface ColFilterValue {
  values: string[];
  contains: string;
}

export const EMPTY_FILTER: ColFilterValue = { values: [], contains: "" };

export function isFilterOn(v: ColFilterValue | undefined): boolean {
  return !!v && (v.values.length > 0 || !!v.contains.trim());
}

export interface HeaderFilterOption {
  value: string;
  /** Readable name shown next to the code; when absent only the code is shown */
  label?: string | null;
}

/**
 * Excel-style filter funnel on a column header — reusable on any data table.
 *
 * Rendered as a portal at the document root: data tables sit inside several `overflow`-clipped
 * boxes, so a panel drawn inside the header cell would be cut off.
 *
 * The panel closes on mousedown outside only, never onBlur — clicking an option blurs before
 * onClick fires, which would close the panel before the value is picked.
 *
 * A table hosting this filter **must not unmount while loading** (e.g. `{loading ? <skeleton/> : <table/>}`),
 * otherwise every re-filter would drop the panel and the input's focus.
 */
export function HeaderFilter({
  label, value, onChange, options, optionsNote, onNeedOptions, loadingOptions, optionsError,
}: {
  /** Title shown on the panel header — usually the column name */
  label: string;
  value: ColFilterValue | undefined;
  /** Called only on "Apply" or "Clear", not on every tick, to avoid a burst of queries */
  onChange: (next: ColFilterValue) => void;
  /** Values to pick from · undefined = no list yet (load on demand, or contains-search only) */
  options?: HeaderFilterOption[];
  /** Note under the list, e.g. "showing the first 200 values" */
  optionsNote?: string;
  /** Shows a "Load values" button — large tables don't load values automatically */
  onNeedOptions?: () => void;
  loadingOptions?: boolean;
  optionsError?: string | null;
}) {
  const cur = value ?? EMPTY_FILTER;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>(cur.values);
  const [text, setText] = useState(cur.contains);
  const [pos, setPos] = useState({ top: 0, left: 0, maxH: 320 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const on = isFilterOn(cur);

  // Every open starts from the applied value, so nothing stale from a previous open lingers
  useEffect(() => {
    if (!open) return;
    setPicked(cur.values);
    setText(cur.contains);
    setQ("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 260, GAP = 6, EDGE = 8;
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    setPos({
      top: r.bottom + GAP,
      left: Math.max(EDGE, Math.min(r.left - W / 2, window.innerWidth - W - EDGE)),
      maxH: Math.max(200, Math.min(360, below)),
    });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const h = () => place();
    window.addEventListener("resize", h);
    // capture: the table scrolls inside its own box, not the page
    window.addEventListener("scroll", h, true);
    return () => { window.removeEventListener("resize", h); window.removeEventListener("scroll", h, true); };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  const shown = useMemo(() => {
    const list = options ?? [];
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((o) => (o.value + " " + (o.label ?? "")).toLowerCase().includes(s));
  }, [options, q]);

  const allShownPicked = shown.length > 0 && shown.every((o) => picked.includes(o.value));

  function toggle(v: string) {
    setPicked((cur2) => (cur2.includes(v) ? cur2.filter((x) => x !== v) : [...cur2, v]));
  }
  function toggleAllShown() {
    const vs = shown.map((o) => o.value);
    setPicked((cur2) => (allShownPicked ? cur2.filter((x) => !vs.includes(x)) : [...new Set([...cur2, ...vs])]));
  }
  function apply() { onChange({ values: picked, contains: text.trim() }); setOpen(false); }
  function clear() { onChange({ ...EMPTY_FILTER }); setOpen(false); }

  const uid = useId();

  return (
    <>
      <span className={`${styles.btn}${on ? " " + styles.on : ""}`}>
        <IconButton ref={btnRef} kind="ghost" size="sm" align="bottom" autoAlign
                    label={on ? "Filtered — click to edit" : "Filter this column"}
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); setOpen((o) => !o); if (!options && onNeedOptions) onNeedOptions(); }}>
          {on ? <FilterEdit size={12} /> : <Filter size={12} />}
        </IconButton>
      </span>

      {open && typeof document !== "undefined" && createPortal(
        <div ref={panelRef} className={styles.panel} role="dialog" aria-label={`Filter ${label}`}
             style={{ top: pos.top, left: pos.left, maxHeight: pos.maxH }}>
          <div className={`cds--type-heading-compact-01 ${styles.head}`}>{label}</div>

          {options && options.length > 0 && (
            <>
              <Search size="sm" autoFocus labelText="Search values" placeholder="Search values"
                      value={q} onChange={(e) => setQ(e.target.value)} closeButtonLabelText="Clear search" />
              <div className={styles.list}>
                <div className={styles.all}>
                  <Checkbox id={`${uid}-all`} checked={allShownPicked} onChange={toggleAllShown}
                            labelText={`Select all${q.trim() ? " (matches)" : ""}`} />
                </div>
                {shown.map((o, i) => (
                  <Checkbox key={o.value} id={`${uid}-${i}`} checked={picked.includes(o.value)} onChange={() => toggle(o.value)}
                            labelText={o.label ? `${o.value} ${o.label}` : o.value} title={o.label ? `${o.value} ${o.label}` : o.value} />
                ))}
                {shown.length === 0 && <div className="cds--type-helper-text-01 rh-dim">No matching values</div>}
              </div>
              {optionsNote && <div className={`cds--type-helper-text-01 ${styles.note}`}>{optionsNote}</div>}
            </>
          )}

          {!options && (
            <div className={`cds--type-helper-text-01 ${styles.note}`}>
              {loadingOptions ? <SkeletonText paragraph lineCount={3} />
                : optionsError ? optionsError
                : onNeedOptions ? "Values are not loaded yet"
                : "Too many values to list — use contains"}
            </div>
          )}
          {!options && onNeedOptions && !loadingOptions && (
            <div style={{ padding: "0 var(--cds-spacing-05) var(--cds-spacing-03)" }}>
              <Button kind="ghost" size="sm" renderIcon={Renew} onClick={onNeedOptions}>Load values</Button>
            </div>
          )}

          <div className={styles.contains}>
            <TextInput id={`${uid}-contains`} size="sm" labelText="Contains" value={text}
                       onChange={(e) => setText(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
                       placeholder="Type a term, press Enter" />
          </div>

          <div className={styles.foot}>
            <Button kind="ghost" size="md" onClick={clear}>Clear</Button>
            <Button kind="secondary" size="md" onClick={() => setOpen(false)}>Cancel</Button>
            <Button kind="primary" size="md" onClick={apply}>Apply</Button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
