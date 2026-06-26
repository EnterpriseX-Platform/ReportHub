"use client";

// Output Files as a folder explorer: report-code folders on the left,
// files of the selected folder on the right, with inline PDF preview.
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { SlideOver } from "@/components/overlays";
import { FmtTag } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api, fetchOutputBlob } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { OutputFile } from "@/lib/types";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function OutputsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<OutputFile[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<OutputFile | null>(null);

  useEffect(() => {
    api.outputs().then(setRows).catch((e) => toast(e instanceof Error ? e.message : "Load failed", "error"));
  }, [toast]);

  // Real folder tree from the object keys (segments split on "/").
  const prefix = path.length ? path.join("/") + "/" : "";
  const inScope = useMemo(() => rows.filter((o) => o.objectKey.startsWith(prefix)), [rows, prefix]);
  const folders = useMemo(() => {
    const m = new Map<string, { count: number; size: number; latest: string }>();
    inScope.forEach((o) => {
      const rest = o.objectKey.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) return;                       // file at this level
      const seg = rest.slice(0, slash);
      const f = m.get(seg) ?? { count: 0, size: 0, latest: o.createdAt };
      f.count++; f.size += o.sizeBytes;
      if (o.createdAt > f.latest) f.latest = o.createdAt;
      m.set(seg, f);
    });
    return [...m.entries()].sort((a, b) => b[1].latest.localeCompare(a[1].latest));
  }, [inScope, prefix]);

  const files = useMemo(() => (q
    ? rows.filter((o) => o.objectKey.toLowerCase().includes(q.toLowerCase()))
    : inScope.filter((o) => !o.objectKey.slice(prefix.length).includes("/")))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [rows, inScope, prefix, q]);

  const totalSize = rows.reduce((s, o) => s + o.sizeBytes, 0);

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Output Files</h1>
          <div className="page-sub">Rendered artifacts in the object store — grouped by report</div>
        </div>
        <div className="page-actions">
          <span className="tag-pill"><Icon name="store" size={13} />{rows.length} files · {fmtBytes(totalSize)}</span>
        </div>
      </div>

      <div className="explorer" style={{ display: "grid", gridTemplateColumns: "250px 1fr", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden", position: "sticky", top: 0 }}>
          <div className="card-head" style={{ padding: "11px 14px" }}>
            <Icon name="store" size={15} style={{ color: "var(--accent)" }} /><h3 style={{ fontSize: 13 }}>Folders</h3>
          </div>
          <div style={{ padding: 6, maxHeight: "calc(100vh - 250px)", overflow: "auto" }}>
            <div onClick={() => setPath([])}
                 style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: path.length === 0 ? "var(--accent-weak)" : "transparent", color: path.length === 0 ? "var(--accent)" : "var(--ink-2)" }}>
              <Icon name="grid" size={14} /><span style={{ fontSize: 12.5, fontWeight: 600 }}>Root</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>{rows.length}</span>
            </div>
            {path.length > 0 && (
              <div onClick={() => setPath((p) => p.slice(0, -1))}
                   style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, cursor: "pointer", color: "var(--ink-3)" }}>
                <Icon name="arrowUp" size={13} /><span style={{ fontSize: 12 }}>.. up one level</span>
              </div>
            )}
            {folders.map(([seg, f]) => (
              <div key={seg} onClick={() => setPath((p) => [...p, seg])}
                   style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, cursor: "pointer" }}>
                <span style={{ color: "var(--amber)" }}><Icon name="viewer" size={15} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 11.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{seg}</div>
                  <div style={{ fontSize: 10, color: "var(--ink-4)" }}>{f.count} files · {fmtBytes(f.size)}</div>
                </div>
                <Icon name="chevron" size={12} style={{ color: "var(--ink-4)" }} />
              </div>
            ))}
            {folders.length === 0 && path.length === 0 && rows.length === 0 && <div className="empty" style={{ padding: 16 }}>No outputs yet</div>}
          </div>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-head" style={{ gap: 10 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-3)", flexWrap: "wrap" }}>
              <span style={{ cursor: "pointer", color: path.length ? "var(--accent)" : "var(--ink)" }} onClick={() => setPath([])}>Outputs</span>
              {path.map((seg, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="chevron" size={12} />
                  <b className="mono" style={{ fontSize: 12, cursor: "pointer" }} onClick={() => setPath(path.slice(0, i + 1))}>{seg}</b>
                </span>
              ))}
            </span>
            <div className="search" style={{ marginLeft: "auto", width: 240 }}>
              <Icon name="search" size={14} /><input placeholder="Search files…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <table className="tbl">
            <thead><tr><th>File</th><th>Format</th><th className="num">Size</th><th>By</th><th>Created</th><th style={{ width: 80 }} /></tr></thead>
            <tbody>
              {files.map((o) => (
                <tr key={o.objectKey} style={{ cursor: "pointer" }} onClick={() => setSel(o)}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <Icon name="doc" size={15} style={{ color: o.fmt === "PDF" ? "var(--red)" : "var(--green)" }} />
                      <span className="mono" style={{ fontSize: 11.5, maxWidth: 380, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q ? o.objectKey : o.objectKey.split("/").pop()}</span>
                    </div>
                  </td>
                  <td><FmtTag f={o.fmt} /></td>
                  <td className="num mono" style={{ fontSize: 11.5 }}>{fmtBytes(o.sizeBytes)}</td>
                  <td style={{ fontSize: 12 }}>{o.createdBy ?? "—"}</td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{timeAgo(o.createdAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm ghost" title="Download" onClick={() => api.downloadOutput(o.objectKey, o.objectKey)}><Icon name="download" size={13} /></button>
                  </td>
                </tr>
              ))}
              {files.length === 0 && <tr><td colSpan={6}><div className="empty">No files{q ? " matching the search" : ""}</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {sel && <FilePreview file={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function FilePreview({ file, onClose }: { file: OutputFile; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    if (file.fmt === "PDF") {
      fetchOutputBlob(file.objectKey).then((b) => { revoke = URL.createObjectURL(b); setUrl(revoke); }).catch(() => {});
    }
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [file]);

  return (
    <SlideOver
      title={file.objectKey}
      sub={`${file.reportCode} · ${file.jobId ?? ""}`}
      badge={<FmtTag f={file.fmt} />}
      onClose={onClose}
      foot={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" onClick={() => api.downloadOutput(file.objectKey, file.objectKey)}><Icon name="download" size={15} />Download {file.fmt}</button>
      </>}
    >
      <div className="kv"><span className="k">Size</span><span className="v mono">{fmtBytes(file.sizeBytes)}</span></div>
      <div className="kv"><span className="k">Created by</span><span className="v">{file.createdBy ?? "—"}</span></div>
      <div className="kv"><span className="k">Created</span><span className="v">{file.createdAt?.replace("T", " ").slice(0, 19)}</span></div>
      {(() => {
        if (!file.params) return null;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(file.params); } catch { return null; }
        const entries = Object.entries(parsed);
        if (entries.length === 0) return null;
        return (
          <div className="kv" style={{ alignItems: "flex-start" }}>
            <span className="k">Parameters</span>
            <span className="v">{entries.map(([k, v]) => (
              <div key={k} className="mono" style={{ fontSize: 12 }}>{k} = {String(v)}</div>
            ))}</span>
          </div>
        );
      })()}
      <div className="divider" />
      {file.fmt === "PDF" ? (
        url
          ? <iframe title="preview" src={url} style={{ width: "100%", height: 560, border: "1px solid var(--line)", borderRadius: 10, background: "#525659" }} />
          : <div className="empty"><span className="spin" /></div>
      ) : (
        <div className="empty" style={{ padding: 30 }}>
          <Icon name="table" size={30} style={{ color: "var(--ink-4)", marginBottom: 8 }} />
          <div>Download to open this {file.fmt} file</div>
        </div>
      )}
    </SlideOver>
  );
}
