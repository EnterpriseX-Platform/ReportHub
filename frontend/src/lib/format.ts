// Display helpers — numbers, durations, Thai Buddhist-era dates, relative time.

export const fmtTHB = (n: number, dec = 0) =>
  (n || 0).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

export const num = (n: number) => new Intl.NumberFormat("en-US").format(n ?? 0);

export const fmtMs = (ms: number) =>
  !ms ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** ISO timestamp → Thai date (Buddhist era). */
export function thaiDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
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
