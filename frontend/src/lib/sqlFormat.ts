/**
 * Lay a SQL statement out on its own lines — the "Format" button behind every SQL box.
 *
 * Modelled on the Integration Platform's SQL editor (client/src/components/flow/FlowDesigner.tsx)
 * so the two tools behave the same way for the same users.
 *
 * Deliberately a text reshuffle, not a parser: it never rewrites, reorders or drops anything, so a
 * statement it cannot make sense of comes back looking odd rather than broken.
 *
 * 🔴 Comments and string literals are masked out before any regex runs, and put back afterwards.
 * Without that the keyword pass pulls the next line up into a `--` comment, which comments the
 * statement out — the formatter would quietly break working SQL. (Integration's version has this
 * bug; the same class of trap as a comma inside a comment breaking a naive statement split.)
 */
const CLAUSES = /\s*\b(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|CONNECT BY|START WITH)\b\s*/gi;
const JOINS = /\s*\b(LEFT JOIN|RIGHT JOIN|INNER JOIN|OUTER JOIN|CROSS JOIN|FULL JOIN|JOIN)\b\s*/gi;
const WRITES = /\s*\b(INSERT INTO|VALUES|UPDATE|SET|DELETE|MERGE INTO|USING|WHEN MATCHED|WHEN NOT MATCHED|UNION ALL|UNION|INTERSECT|MINUS|EXCEPT)\b\s*/gi;

const INDENTED = ["FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
                  "CROSS JOIN", "FULL JOIN", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT",
                  "OFFSET", "CONNECT BY", "START WITH"];

// Private-use code points: they cannot occur in SQL anyone types, and they are not word
// characters, so \b and \s* behave around a marker as they would around punctuation.
const OPEN = "\uE000", CLOSE = "\uE001";
const ref = (i: number) => OPEN + i + CLOSE;

export function formatSql(value: string): string {
  const { masked, parts, lineComments } = mask(value);

  let formatted = masked
    // $1, never a literal: whatever case the author writes keywords in is theirs to keep, and
    // this pass would otherwise uppercase SELECT alone and leave FROM/WHERE as typed.
    .replace(/\s*\b(SELECT)\b\s+/gi, "$1 ")
    .replace(/\s*,\s*/g, ", ")
    .replace(CLAUSES, "\n$1 ")
    .replace(JOINS, "\n$1 ")
    .replace(WRITES, "\n$1 ");

  // A `--` comment runs to end of line, so whatever followed it must start a new one.
  for (const i of lineComments) formatted = formatted.split(ref(i)).join(ref(i) + "\n");

  const lines: string[] = [];
  for (const raw of formatted.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const select = /^(SELECT)\s+(.+)$/i.exec(line);
    // A long SELECT list goes one column per line — but only when it is long enough to be worth
    // it; `SELECT a, b` reads better as it was written.
    if (select && splitTopLevel(select[2]).length > 4) {
      lines.push(select[1]);
      lines.push(...splitTopLevel(select[2]).map((c, i, all) => "  " + c + (i < all.length - 1 ? "," : "")));
      continue;
    }
    const upper = line.toUpperCase();
    if (upper.startsWith("AND ") || upper.startsWith("OR ")) lines.push("    " + line);
    else if (!upper.startsWith("SELECT") && INDENTED.some((k) => upper.startsWith(k))) lines.push("  " + line);
    else lines.push(line);
  }

  return unmask(lines.join("\n"), parts);
}

/**
 * Replace every string literal and comment with an opaque marker, so the keyword and comma passes
 * only ever see code. `lineComments` is which markers end their line.
 */
function mask(sql: string): { masked: string; parts: string[]; lineComments: Set<number> } {
  const parts: string[] = [];
  const lineComments = new Set<number>();
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      lineComments.add(parts.length);
      out += ref(parts.length); parts.push(sql.slice(i, stop));
      i = stop;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += ref(parts.length); parts.push(sql.slice(i, stop));
      i = stop;
    } else if (sql[i] === "'" || sql[i] === '"') {
      const q = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === q) { if (sql[j + 1] === q) { j += 2; continue; } j++; break; } // '' is an escaped quote
        j++;
      }
      out += ref(parts.length); parts.push(sql.slice(i, j));
      i = j;
    } else {
      out += sql[i]; i++;
    }
  }
  return { masked: out, parts, lineComments };
}

function unmask(text: string, parts: string[]): string {
  return text.replace(new RegExp(OPEN + "(\\d+)" + CLOSE, "g"), (_, n) => parts[Number(n)] ?? "");
}

/** Split on the commas that separate columns — ones inside `f(a, b)` belong to the expression. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
