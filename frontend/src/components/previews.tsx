// Document previews (PDF look + spreadsheet look) shared by Tester and Output Files.
import { Icon } from "./Icon";
import { fmtTHB } from "@/lib/format";
import { FISCAL_YEAR } from "@/lib/facts";

export function PdfPreview({
  title,
  code,
  dsName,
  params = {},
  scale = 1,
}: {
  title: string;
  code: string;
  dsName: string;
  params?: Record<string, unknown>;
  scale?: number;
}) {
  const rows: [string, number, number, number][] = [
    ["Central", 331204.5, 318900.1, 96.3],
    ["East", 169882.3, 165430.8, 97.4],
    ["North", 316561.0, 309122.4, 97.6],
    ["West", 228132.7, 210488.9, 92.3],
    ["Bangkok", 124711.2, 119003.6, 95.4],
    ["South", 198320.0, 195771.2, 98.7],
  ];
  const total = rows.reduce((s, r) => s + r[1], 0);
  const cell = { padding: "7px 10px", border: "1px solid #d4d8e0" } as const;
  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: "top center" }}>
      <div style={{ width: 600, minHeight: 800, background: "#fff", boxShadow: "0 8px 30px -8px rgba(0,0,0,.25)", padding: "48px 52px", fontFamily: "var(--font)", color: "#1a1a1a" }}>
        <div style={{ display: "flex", alignItems: "center", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          <div style={{ width: 46, height: 46, borderRadius: "50%", border: "1.5px solid #b58a3a", display: "grid", placeItems: "center", color: "#b58a3a" }}><Icon name="star" size={26} /></div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Organization Name</div>
          <div style={{ fontSize: 11, color: "#666" }}>Organization</div>
        </div>
        <div style={{ borderTop: "2px solid #1a1a1a", borderBottom: "1px solid #1a1a1a", padding: "10px 0", textAlign: "center", margin: "10px 0 6px" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: "#444", marginTop: 3 }}>Fiscal year {String(params.fiscalYear ?? FISCAL_YEAR)} · Quarter {String(params.quarter ?? "Full year")}</div>
        </div>
        <div style={{ fontSize: 10, color: "#888", textAlign: "right", marginBottom: 14 }}>Unit: THB millions · Report code {code}</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr style={{ background: "#f0f2f6" }}>
              <th style={{ ...cell, textAlign: "left", fontWeight: 600 }}>Region</th>
              <th style={{ ...cell, textAlign: "right", fontWeight: 600 }}>Target</th>
              <th style={{ ...cell, textAlign: "right", fontWeight: 600 }}>Sales</th>
              <th style={{ ...cell, textAlign: "right", fontWeight: 600 }}>%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={cell}>{r[0]}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtTHB(r[1], 1)}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtTHB(r[2], 1)}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r[3].toFixed(1)}</td>
              </tr>
            ))}
            <tr style={{ background: "#f7f9fc", fontWeight: 700 }}>
              <td style={cell}>Total</td>
              <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtTHB(total, 1)}</td>
              <td colSpan={2} style={cell} />
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 20, fontSize: 11, color: "#555", lineHeight: 1.8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Note</div>
          Processed from {dsName} as of 9 Jun 2026
        </div>
        <div style={{ marginTop: 28, borderTop: "1px solid #ddd", paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 10, color: "#999" }}>
          <span>Report Studio</span><span>Page 1 / 14</span>
        </div>
      </div>
    </div>
  );
}

// Deterministic sample rows mirroring the warehouse seed.
const SHEET_REGIONS = ["North", "Central", "Northeast", "South", "East", "West"];
const SHEET_CHANNELS = ["Online", "In-store", "Wholesale"];
const seed = (a: number, b: number) => ((a * 73 + b * 131) % 1000) / 1000;

export function SheetPreview({ code }: { code: string }) {
  const cols = ["Region", "Channel", "Target", "Sales", "Profit", "Variance"];
  const data = SHEET_REGIONS.flatMap((m, mi) =>
    SHEET_CHANNELS.map((p, pi) => {
      const target = Math.round(800 + seed(mi, pi) * 14000);
      const sales = Math.round(target * (0.82 + seed(pi, mi) * 0.16));
      const profit = Math.round(sales * (0.55 + seed(mi + 1, pi) * 0.4));
      return [m, p, target, sales, profit, sales - profit] as (string | number)[];
    }));
  const colLetters = ["A", "B", "C", "D", "E", "F", "G"];
  return (
    <div style={{ width: 620, background: "#fff", boxShadow: "0 8px 30px -8px rgba(0,0,0,.25)", borderRadius: 4, overflow: "hidden", fontFamily: "var(--mono)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#1a7a48", color: "#fff", fontSize: 12, fontFamily: "var(--font)" }}>
        <Icon name="table" size={15} /><b>{code}.xlsx</b><span style={{ marginLeft: "auto", opacity: 0.8 }}>Sheet1</span>
      </div>
      <div style={{ overflow: "auto", maxHeight: 420 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 30, background: "#eef1f4", border: "1px solid #d6dae0" }} />
              {colLetters.slice(0, cols.length).map((c) => <th key={c} style={{ background: "#eef1f4", border: "1px solid #d6dae0", color: "#777", fontWeight: 500, padding: "3px 8px", textAlign: "center" }}>{c}</th>)}
            </tr>
            <tr>
              <td style={{ background: "#eef1f4", border: "1px solid #d6dae0", color: "#999", textAlign: "center", fontSize: 10 }}>1</td>
              {cols.map((c) => <td key={c} style={{ background: "#dff0e6", border: "1px solid #d6dae0", padding: "5px 8px", fontWeight: 700, fontFamily: "var(--font)", whiteSpace: "nowrap" }}>{c}</td>)}
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i}>
                <td style={{ background: "#eef1f4", border: "1px solid #d6dae0", color: "#999", textAlign: "center", fontSize: 10 }}>{i + 2}</td>
                {row.map((c, j) => <td key={j} style={{ border: "1px solid #e2e6ea", padding: "4px 8px", textAlign: j < 2 ? "left" : "right", fontFamily: j < 2 ? "var(--font)" : "var(--mono)", whiteSpace: "nowrap", color: "#222" }}>{typeof c === "number" ? fmtTHB(c) : c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FileIcon({ fmt, big }: { fmt: string; big?: boolean }) {
  const col = ({ PDF: "#c0392b", XLSX: "#1a7a48", DOCX: "#285f9c", CSV: "#6b7484" } as Record<string, string>)[fmt] ?? "#6b7484";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: big ? 4 : 0 }}>
      <Icon name="doc" size={big ? 26 : 17} style={{ color: col }} />
      {big && <span style={{ fontSize: 9, fontWeight: 700, color: col, letterSpacing: ".5px" }}>{fmt}</span>}
    </div>
  );
}
