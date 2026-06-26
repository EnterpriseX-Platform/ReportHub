// Syntax-highlighted YAML viewer (line numbers + key/value coloring).
export function ConfigViewer({ yaml, height }: { yaml: string; height?: number }) {
  const lines = yaml.split("\n");
  return (
    <div style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 10, overflow: "auto", maxHeight: height ?? 420, fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.7 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {lines.map((ln, i) => {
            const m = ln.match(/^(\s*)(- )?([\w$]+)(:)(.*)$/);
            return (
              <tr key={i}>
                <td style={{ width: 34, textAlign: "right", padding: "0 10px", color: "var(--ink-4)", userSelect: "none", borderRight: "1px solid var(--line)", background: "var(--surface-3)", verticalAlign: "top" }}>{i + 1}</td>
                <td style={{ padding: "0 14px", whiteSpace: "pre", color: "var(--ink-2)" }}>
                  {m ? (
                    <>
                      {m[1]}
                      {m[2] && <span style={{ color: "var(--ink-4)" }}>{m[2]}</span>}
                      <span style={{ color: "var(--accent)", fontWeight: 600 }}>{m[3]}</span>
                      <span style={{ color: "var(--ink-4)" }}>:</span>
                      <span style={{ color: "var(--green)" }}>{m[5]}</span>
                    </>
                  ) : ln}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
