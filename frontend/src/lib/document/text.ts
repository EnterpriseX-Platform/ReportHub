// Inline text helpers: {{param}} placeholders and a small markup (**bold**, *italic*, __underline__).

export function fillParams(text: string, params: Record<string, string>, extra: Record<string, string> = {}): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, k: string) =>
    k in extra ? extra[k] : k in params ? params[k] : m);
}

export type Run = { t: string; b?: boolean; i?: boolean; u?: boolean };

/** Parse the inline markup into styled runs. Unbalanced markers are kept as literal text. */
export function parseRuns(src: string): Run[] {
  const out: Run[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: src.slice(last, m.index) });
    if (m[2] != null) out.push({ t: m[2], b: true });
    else if (m[3] != null) out.push({ t: m[3], u: true });
    else out.push({ t: m[4], i: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: src.slice(last) });
  return out;
}

let seq = 0;
/** Short unique id for sections and blocks. */
export function uid(prefix = "b"): string {
  seq = (seq + 1) % 1e6;
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + seq.toString(36);
}
