// Syntax-highlighted YAML viewer (line numbers + key/value coloring), on Carbon tokens.
export function ConfigViewer({ yaml, height }: { yaml: string; height?: number }) {
  const lines = yaml.split("\n");
  return (
    <div className="cds--type-code-01" style={{ background: "var(--cds-layer-02)", border: "1px solid var(--cds-border-subtle-01)", overflow: "auto", maxHeight: height ?? 420, lineHeight: 1.7 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {lines.map((ln, i) => {
            const m = ln.match(/^(\s*)(- )?([\w$]+)(:)(.*)$/);
            return (
              <tr key={i}>
                <td style={{ width: 34, textAlign: "right", padding: "0 var(--cds-spacing-03)", color: "var(--cds-text-helper)", userSelect: "none", borderRight: "1px solid var(--cds-border-subtle-01)", background: "var(--cds-layer-accent-01)", verticalAlign: "top" }}>{i + 1}</td>
                <td style={{ padding: "0 var(--cds-spacing-04)", whiteSpace: "pre", color: "var(--cds-text-primary)" }}>
                  {m ? (
                    <>
                      {m[1]}
                      {m[2] && <span style={{ color: "var(--cds-text-helper)" }}>{m[2]}</span>}
                      <span style={{ color: "var(--cds-link-primary)", fontWeight: 600 }}>{m[3]}</span>
                      <span style={{ color: "var(--cds-text-helper)" }}>:</span>
                      <span style={{ color: "var(--cds-support-success)" }}>{m[5]}</span>
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
