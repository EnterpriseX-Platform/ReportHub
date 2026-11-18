"use client";

// Full-size paginated preview with parameter values, browser print and PDF export (via the exporter).
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { api, docApi, errorStatus } from "@/lib/api";
import { Button, TextInput, Tag } from "@carbon/react";
import { ArrowLeft, Launch, Printer, Upload, DocumentPdf } from "@carbon/icons-react";
import { usePerms } from "@/lib/perms";
import type { BlockData, DocRecord } from "@/lib/document/types";
import { DocPages } from "@/components/document/DocPages";

export default function DocumentPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const canExport = usePerms().can("RH.DOCUMENT", "execute");
  const [rec, setRec] = useState<DocRecord | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [data, setData] = useState<Record<string, BlockData>>({});
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    docApi.get(Number(id)).then((r) => {
      setRec(r);
      const v = Object.fromEntries(r.content.params.map((p) => [p.name, p.defaultValue ?? ""]));
      setVals(v); setApplied(v);
    }).catch((e) => toast(e instanceof Error ? e.message : "Load failed", "error"));
  }, [id, toast]);

  useEffect(() => {
    if (!rec) return;
    docApi.dataFor(rec.content, applied).then(setData).catch((e) => toast(e instanceof Error ? e.message : "Data failed", "error"));
  }, [rec, applied, toast]);

  const [fhUrl, setFhUrl] = useState<string | null>(null);
  const [hasFileHub, setHasFileHub] = useState(false);
  useEffect(() => { api.fileHubTargets().then((t) => setHasFileHub(t.length > 0)).catch(() => {}); }, []);

  async function exportPdf() {
    if (!rec) return;
    setBusy(true);
    try { await docApi.exportPdf(rec.id, applied, `${rec.title.replace(/[^A-Za-z0-9._ -]/g, "_")}.pdf`); }
    catch (e) {
      toast(errorStatus(e) === 504
        ? "The PDF exporter did not answer in time (504). Try again, or reduce the document size."
        : e instanceof Error ? e.message : "Export failed", "error");
    }
    finally { setBusy(false); }
  }

  async function publish() {
    if (!rec) return;
    setBusy(true);
    try {
      const r = await docApi.publishToFileHub(rec.id, applied);
      setFhUrl(r.filehubUrl ?? null);
      toast("PDF published to FileHub", "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Publish failed", "error"); }
    finally { setBusy(false); }
  }

  if (!rec) return null;
  return (
    <div>
      <div className="rh-page-header doc-noprint">
        <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
          <Button as={Link} href={`/documents/${rec.id}`} kind="ghost" size="sm" renderIcon={ArrowLeft}>Edit</Button>
          <h1 className="cds--type-productive-heading-04 rh-page-header__title">{rec.title}</h1>
          <span className="cds--type-label-01 rh-dim">{pages ? `${pages} pages` : ""}</span>
        </div>
        <div className="rh-page-header__actions">
          <Button kind="secondary" size="md" renderIcon={Printer} onClick={() => window.print()}>Print</Button>
          {fhUrl && <Tag type="blue" renderIcon={Launch} onClick={() => window.open(fhUrl, "_blank", "noreferrer")}>FileHub</Tag>}
          {canExport && hasFileHub && <Button kind="tertiary" size="md" renderIcon={Upload} onClick={publish} disabled={busy}>Publish to FileHub</Button>}
          {canExport && <Button size="md" renderIcon={DocumentPdf} onClick={exportPdf} disabled={busy}>{busy ? "Exporting" : "Export PDF"}</Button>}
        </div>
      </div>
      {rec.content.params.length > 0 && (
        <div className="doc-noprint" style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 16 }}>
          {rec.content.params.map((p) => (
            <div key={p.name} style={{ width: 200 }}>
              <TextInput id={`param-${p.name}`} size="sm" labelText={p.label || p.name} value={vals[p.name] ?? ""}
                         onChange={(e) => setVals((v) => ({ ...v, [p.name]: e.target.value }))} />
            </div>
          ))}
          <Button kind="tertiary" size="sm" onClick={() => setApplied(vals)}>Apply</Button>
        </div>
      )}
      <div className="rh-docx-preview" style={{ minHeight: "70vh" }}>
        <DocPages content={rec.content} params={applied} data={data} onPageCount={setPages} />
      </div>
    </div>
  );
}
