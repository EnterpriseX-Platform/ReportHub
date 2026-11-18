// Display helpers — numbers, durations, localized dates, relative time.

export const fmtAmount = (n: number, dec = 0) =>
  (n || 0).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

export const num = (n: number) => new Intl.NumberFormat("en-US").format(n ?? 0);

export const fmtMs = (ms: number) =>
  !ms ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/**
 * Locale (BCP 47, may carry a calendar extension such as `-u-ca-buddhist`) used for long dates.
 * Set NEXT_PUBLIC_DATE_LOCALE; unset = the browser's own locale.
 */
const DATE_LOCALE: string | undefined = process.env.NEXT_PUBLIC_DATE_LOCALE || undefined;

/** ISO timestamp → localized date/time (see {@link DATE_LOCALE}). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (isNaN(d)) return iso;
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Server timestamp → "YYYY-MM-DD HH:mm[:ss]" in the browser's local time zone. Server timestamps
 * carry an offset; slicing the string showed the server's zone instead, so every screen uses this.
 * A string without an offset (a bare LocalDateTime) is shown as-is.
 */
export function localTime(ts: string | null | undefined, seconds = false): string {
  if (!ts) return "";
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts);
  const d = new Date(ts);
  if (!hasZone || isNaN(d.getTime())) return ts.replace("T", " ").slice(0, seconds ? 19 : 16);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    + (seconds ? `:${p(d.getSeconds())}` : "");
}

/** Current local clock "HH:mm:ss.SSS" (run logs). */
export function localClock(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
