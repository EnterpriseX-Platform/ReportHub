"use client";

import { useEffect, useState } from "react";

/**
 * localStorage key under which a host portal (on the same origin) publishes its selected year.
 * Set NEXT_PUBLIC_YEAR_STORAGE_KEY to enable; empty (the default) disables host-year integration.
 */
export const YEAR_STORAGE_KEY: string = (process.env.NEXT_PUBLIC_YEAR_STORAGE_KEY ?? "").trim();

/**
 * First month (1-12) of the fiscal year; a fiscal year is named after the calendar year it ends in.
 * Set NEXT_PUBLIC_FISCAL_YEAR_START_MONTH; default 1 (fiscal year = calendar year).
 */
export const FISCAL_YEAR_START_MONTH: number = (() => {
  const n = Number(process.env.NEXT_PUBLIC_FISCAL_YEAR_START_MONTH ?? "1");
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
})();

/**
 * The fiscal year the host portal is set to.
 *
 * When a host portal frames these screens and keeps its year picker in localStorage on the same
 * origin (under {@link YEAR_STORAGE_KEY}), every screen follows it; changes arrive as a `storage`
 * event. Returns "" when no key is configured or Report Studio is opened outside the portal.
 *
 * Lives here rather than in one page because both the data screens (read) and Data Warehouse
 * (write) need the same value, and two copies would drift.
 */
export function usePortalYear(): string {
  const [year, setYear] = useState("");
  useEffect(() => {
    if (!YEAR_STORAGE_KEY) return;
    const read = () => {
      try { setYear(localStorage.getItem(YEAR_STORAGE_KEY)?.trim() ?? ""); } catch { setYear(""); }
    };
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === YEAR_STORAGE_KEY || e.key === null) read(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return year;
}

/**
 * Current fiscal year (Gregorian) from the local clock; a fallback when not opened via the portal.
 *
 * The fiscal year starts in {@link FISCAL_YEAR_START_MONTH}; e.g. with a start month of 10,
 * Oct 2025 – Sep 2026 is fiscal year 2026. Use only when the real year is unknown; the portal's
 * year always wins.
 */
export function fiscalYearNow(): string {
  const d = new Date();
  const startsNext = FISCAL_YEAR_START_MONTH > 1 && d.getMonth() >= FISCAL_YEAR_START_MONTH - 1;
  return String(d.getFullYear() + (startsNext ? 1 : 0));
}

/** `2026` -> `26`. The two-digit year shape some fact tables store. */
export function year2(year: string): string {
  return year.slice(-2);
}

/**
 * Groups rows under their folder path for a tree-ish list. `null`/blank folders collect under
 * `""`, which callers render last as "ungrouped". Order of first appearance is preserved so the
 * caller's own sort still decides what comes first.
 */
export function byFolder<T>(rows: T[], folderOf: (row: T) => string | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const key = (folderOf(r) ?? "").trim();
    const list = out.get(key);
    if (list) list.push(r); else out.set(key, [r]);
  }
  return out;
}
