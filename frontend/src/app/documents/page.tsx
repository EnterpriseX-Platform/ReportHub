"use client";

// Documents: page-layout documents (sections, formula tables, data-bound tables, images) exported to PDF.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { AccessButton } from "@/components/AccessPanel";
import { usePerms } from "@/lib/perms";
import { api, docApi } from "@/lib/api";
import { Button, TextInput, Search, Tile, RadioTile, TileGroup, Tag } from "@carbon/react";
import { Add, Launch } from "@carbon/icons-react";
import { DataList } from "@/components/DataList";
import { Modal } from "@/components/overlays";
import { PageHeader, TableSkeleton } from "@/components/ui";
import type { DocSummary } from "@/lib/document/types";
import { TEMPLATES } from "@/lib/document/templates";

export default function DocumentsPage() {
  const toast = useToast();
  const { can } = usePerms();
  const router = useRouter();
  const [rows, setRows] = useState<DocSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [tpl, setTpl] = useState(TEMPLATES[0].id);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  /** Document awaiting delete confirmation (danger modal instead of window.confirm) */
  const [confirmDel, setConfirmDel] = useState<DocSummary | null>(null);
  const [hasFileHub, setHasFileHub] = useState(false);
  useEffect(() => { api.fileHubTargets().then((t) => setHasFileHub(t.length > 0)).catch(() => {}); }, []);
  async function publish(d: DocSummary) {
    try {
      const r = await docApi.publishToFileHub(d.id);
      setRows((rs) => (rs ?? []).map((x) => (x.id === d.id ? { ...x, ...r } : x)));
      toast(`Published ${d.title} to FileHub`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Publish failed", "error"); }
  }

  const reload = useCallback(() => {
    docApi.list().then(setRows).catch((e) => toast(e instanceof Error ? e.message : "Load failed", "error"));
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  async function create() {
    const t = TEMPLATES.find((x) => x.id === tpl)!;
    setBusy(true);
    try {
      const r = await docApi.create({ title: title.trim() || t.name, content: t.build() });
      router.push(`/documents/${r.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
      setBusy(false);
    }
  }
  async function copy(d: DocSummary) {
    try { await docApi.copy(d.id); toast(`Copied ${d.title}`, "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Copy failed", "error"); }
  }
  async function remove(d: DocSummary) {
    try { await docApi.remove(d.id); toast(`Deleted ${d.title}`, "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  const shown = (rows ?? []).filter((d) => !q || d.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Documents"
                  actions={can("RH.DOCUMENT", "create") && <Button renderIcon={Add} onClick={() => setCreating((v) => !v)}>New document</Button>} />

      {creating && (
        <Tile style={{ marginBottom: 16 }}>
          <TileGroup name="doc-template" legend="Template" valueSelected={tpl} onChange={(v) => setTpl(String(v))}>
            <div className="rh-docx-tpl">
              {TEMPLATES.map((t) => (
                <RadioTile key={t.id} id={`tpl-${t.id}`} value={t.id}>
                  <div className="cds--type-heading-compact-01">{t.name}</div>
                  <div className="cds--type-label-01 rh-dim" style={{ marginTop: 4 }}>{t.description}</div>
                </RadioTile>
              ))}
            </div>
          </TileGroup>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 16 }}>
            <div style={{ width: 320, maxWidth: "100%" }}>
              <TextInput id="doc-title" labelText="Title" placeholder={TEMPLATES.find((t) => t.id === tpl)?.name} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <Button kind="secondary" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create} disabled={busy}>Create</Button>
          </div>
        </Tile>
      )}

      {rows === null ? <TableSkeleton columns={5} /> : (
        <DataList
          rows={shown.map((d) => ({ ...d, id: String(d.id), _d: d }))}
          search={false}
          toolbar={<Search size="lg" labelText="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />}
          empty="No documents yet"
          columns={[
            { key: "title", header: "Title", render: (r) => (
              <div>
                <Link href={`/documents/${r._d.id}`} className="cds--link" style={{ fontWeight: 600 }}>{r.title}</Link>
                {r.filehubUrl && <Tag size="sm" type="blue" renderIcon={Launch} style={{ marginLeft: 8 }} title={`FileHub file ${r.filehubFileId}`}
                                      onClick={() => window.open(r.filehubUrl!, "_blank", "noreferrer")}>FileHub</Tag>}
                {r.description && <div className="cds--type-label-01 rh-dim">{r.description}</div>}
              </div>
            ) },
            { key: "updatedAt", header: "Updated", sortValue: (r) => r.updatedAt, render: (r) => new Date(r.updatedAt).toLocaleString() },
            { key: "updatedBy", header: "By", render: (r) => r.updatedBy ?? "—" },
            { key: "revision", header: "Revision", align: "end", render: (r) => <span className="cds--type-code-01">{r.revision}</span> },
          ]}
          rowActions={(r) => (
            <>
              <Button as={Link} href={`/documents/${r._d.id}/preview`} kind="ghost" size="sm">Preview</Button>
              {hasFileHub && can("RH.DOCUMENT", "execute") && <Button kind="ghost" size="sm" title="Export the PDF and publish it to FileHub" onClick={() => publish(r._d)}>Publish</Button>}
              {can("RH.DOCUMENT", "create") && <Button kind="ghost" size="sm" onClick={() => copy(r._d)}>Copy</Button>}
              <AccessButton type="DOCUMENT" id={r._d.id} name={r.title} small />
              {can("RH.DOCUMENT", "delete") && <Button kind="danger--ghost" size="sm" onClick={() => setConfirmDel(r._d)}>Delete</Button>}
            </>
          )}
        />
      )}

      {confirmDel && (
        <Modal title={`Delete “${confirmDel.title}”?`} sub="This cannot be undone" danger width={400} onClose={() => setConfirmDel(null)}
               foot={<>
                 <Button kind="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
                 <Button kind="danger" onClick={() => { const d = confirmDel; setConfirmDel(null); remove(d); }}>Delete</Button>
               </>}>
          <p className="cds--type-body-01">{confirmDel.title}</p>
        </Modal>
      )}
    </div>
  );
}
