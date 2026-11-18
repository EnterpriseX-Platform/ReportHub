"use client";

// Document editor: section tree (left), block editor (middle), live paginated preview (right).
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select } from "@/components/Select";
import { Button, FileUploaderDropContainer, IconButton, InlineNotification, Tag, TextArea } from "@carbon/react";
import { Add, ArrowDown, ArrowLeft, ArrowUp, Close } from "@carbon/icons-react";
import { F, Chk } from "./P/fields";
import { useToast } from "@/components/Toast";
import { AccessButton } from "@/components/AccessPanel";
import { usePerms } from "@/lib/perms";
import { api, apiUrl, docApi } from "@/lib/api";
import type { DatasetDef } from "@/lib/types";
import type {
  Block, BlockData, BlockType, DocContent, DocParam, DocRecord, ImageBlock, Orientation, Section, TableBlock,
} from "@/lib/document/types";
import { PAGE_SIZES, pageSizeOf } from "@/lib/document/pageSizes";
import { defaultTotalColumns, makeGrid } from "@/lib/document/grid";
import { uid } from "@/lib/document/text";
import { DocPages, FONT_CHOICES } from "./DocPages";
import { GridEditor } from "./GridEditor";

type SaveState = "saved" | "saving" | "dirty" | "error";
const SETTINGS = "__settings__";

const BLOCK_LABEL: Record<BlockType, string> = {
  heading: "Heading", paragraph: "Text", table: "Table", image: "Image", toc: "Contents",
  divider: "Divider", pageBreak: "Page break", spacer: "Spacer",
};

function newBlock(type: BlockType): Block {
  const id = uid();
  switch (type) {
    case "heading": return { id, type, level: 2, text: "Heading" };
    case "paragraph": return { id, type, text: "" };
    case "table": {
      const grid = makeGrid(3, 3);
      grid[0].forEach((c, i) => { c.text = `Column ${i + 1}`; });
      return { id, type, grid, headerRows: 1 };
    }
    case "image": return { id, type, url: "", widthPct: 60, align: "center" };
    case "toc": return { id, type, title: "Contents", maxLevel: 2 };
    case "divider": return { id, type };
    case "pageBreak": return { id, type };
    case "spacer": return { id, type, heightMm: 10 };
  }
}

const sqlParams = (sql: string) => Array.from(new Set(Array.from(sql.matchAll(/\$P!?\{([A-Za-z0-9_.]+)\}/g)).map((m) => m[1])));

function hasBound(c: DocContent) {
  return c.sections.some((s) => s.blocks.some((b) => b.type === "table" && b.source));
}

export function DocEditor({ id }: { id: number }) {
  const toast = useToast();
  const [rec, setRec] = useState<DocRecord | null>(null);
  /** Section whose delete was clicked once (in-place two-step confirm instead of window.confirm) */
  const [confirmSec, setConfirmSec] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState<DocContent | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [secId, setSecId] = useState<string>(SETTINGS);
  const [selBlock, setSelBlock] = useState<string | null>(null);
  const canEdit = usePerms().can("RH.DOCUMENT", "update");
  const [showPreview, setShowPreview] = useState(true);
  const [datasets, setDatasets] = useState<DatasetDef[]>([]);
  const [data, setData] = useState<Record<string, BlockData>>({});
  const [pageCount, setPageCount] = useState(0);
  const revision = useRef(0);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    docApi.get(id).then((r) => {
      setRec(r); setTitle(r.title); setContent(r.content); revision.current = r.revision;
      setSecId(r.content.sections[0]?.id ?? SETTINGS);
    }).catch((e) => toast(e instanceof Error ? e.message : "Load failed", "error"));
    api.datasets().then(setDatasets).catch(() => {});
  }, [id, toast]);

  const params = useMemo(() => Object.fromEntries((content?.params ?? []).map((p) => [p.name, p.defaultValue ?? ""])), [content?.params]);

  // --- save (debounced autosave + Ctrl/Cmd+S) ---
  const save = useCallback(async () => {
    if (!content) return;
    setState("saving");
    try {
      const r = await docApi.save(id, { title: title.trim() || "Untitled", description: rec?.description, folder: rec?.folder, content, revision: revision.current });
      revision.current = r.revision;
      setState("saved");
      setSaveErr(null);
    } catch (e) {
      setState("error");
      // 400s name the offending field (e.g. content.page.marginsMm.top); show it inline, not as a toast.
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    }
  }, [content, id, rec, title, toast]);

  useEffect(() => {
    if (state !== "dirty") return;
    const t = setTimeout(save, 1500);
    return () => clearTimeout(t);
  }, [state, save]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save]);

  // --- bound data for the live preview (debounced) ---
  useEffect(() => {
    if (!content || !hasBound(content)) { setData({}); return; }
    const t = setTimeout(() => { docApi.dataFor(content, params).then(setData).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [content, params]);

  const change = (fn: (c: DocContent) => DocContent) => { setContent((c) => (c ? fn(c) : c)); setState("dirty"); };
  const changeSection = (sid: string, fn: (s: Section) => Section) => change((c) => ({ ...c, sections: c.sections.map((s) => (s.id === sid ? fn(s) : s)) }));
  const changeBlock = (sid: string, bid: string, patch: Partial<Block>) =>
    changeSection(sid, (s) => ({ ...s, blocks: s.blocks.map((b) => (b.id === bid ? ({ ...b, ...patch } as Block) : b)) }));

  if (!content || !rec) return null;
  const section = content.sections.find((s) => s.id === secId);

  const addSection = () => {
    const s: Section = { id: uid("s"), title: `Section ${content.sections.length + 1}`, newPage: true, blocks: [{ id: uid(), type: "heading", level: 1, text: "New section" }] };
    change((c) => ({ ...c, sections: [...c.sections, s] }));
    setSecId(s.id);
  };
  const moveSection = (i: number, d: number) => change((c) => {
    const a = c.sections.slice(); const j = i + d;
    if (j < 0 || j >= a.length) return c;
    [a[i], a[j]] = [a[j], a[i]];
    return { ...c, sections: a };
  });
  const removeSection = (sid: string) => {
    change((c) => ({ ...c, sections: c.sections.filter((s) => s.id !== sid) }));
    setSecId(SETTINGS);
  };

  return (
    <div>
      <div className="rh-page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <Button as={Link} href="/documents" kind="ghost" size="sm" renderIcon={ArrowLeft}>Documents</Button>
          <F aria-label="Document title" value={title} style={{ flex: 1, fontWeight: 600, maxWidth: 420 }}
            onChange={(e) => { setTitle(e.target.value); setState("dirty"); }} />
          <span className="cds--type-label-01" style={{ color: state === "error" ? "var(--cds-text-error)" : "var(--cds-text-secondary)", whiteSpace: "nowrap" }}>
            {state === "saved" ? "Saved" : state === "saving" ? "Saving" : state === "dirty" ? "Unsaved changes" : "Save failed"}
            {pageCount ? ` · ${pageCount} page${pageCount > 1 ? "s" : ""}` : ""}
          </span>
        </div>
        <div className="rh-page-header__actions">
          <Button kind="ghost" size="sm" onClick={() => setShowPreview((v) => !v)}>{showPreview ? "Hide preview" : "Show preview"}</Button>
          <AccessButton type="DOCUMENT" id={id} name={title} />
          {canEdit && <Button kind="tertiary" size="sm" onClick={save} disabled={state === "saving"}>Save</Button>}
          <Button as={Link} size="sm" href={`/documents/${id}/preview`} onClick={() => { if (state === "dirty") save(); }}>Preview &amp; export</Button>
        </div>
      </div>

      {saveErr && <InlineNotification kind="error" role="alert" title="Save failed" subtitle={saveErr} hideCloseButton lowContrast style={{ maxWidth: "none", marginBottom: 12 }} />}
      <div className={"rh-docx-shell rh-fill" + (showPreview ? "" : " rh-docx--no-preview")}>
        <div className="rh-docx-pane rh-docx-tree">
          <div className={"rh-docx-sec" + (secId === SETTINGS ? " rh-docx--active" : "")} onClick={() => setSecId(SETTINGS)}>Page setup &amp; parameters</div>
          <div className="rh-docx-tree-h">Sections <Button kind="ghost" size="sm" renderIcon={Add} onClick={addSection}>Add</Button></div>
          {content.sections.map((s, i) => (
            <div key={s.id} className={"rh-docx-sec" + (s.id === secId ? " rh-docx--active" : "") + (s.disabled ? " rh-docx--off" : "")} onClick={() => setSecId(s.id)}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title || "Untitled"}</span>
              {(s.orientation ?? content.page.orientation) === "landscape" && <Tag size="sm" type="cool-gray">L</Tag>}
              <span className="rh-docx-acts">
                {confirmSec === s.id && <Button kind="danger--ghost" size="sm" onClick={(e) => { e.stopPropagation(); setConfirmSec(null); removeSection(s.id); }}>Delete?</Button>}
                <IconButton kind="ghost" size="sm" align="left" label="Move up" onClick={(e) => { e.stopPropagation(); moveSection(i, -1); }}><ArrowUp /></IconButton>
                <IconButton kind="ghost" size="sm" align="left" label="Move down" onClick={(e) => { e.stopPropagation(); moveSection(i, 1); }}><ArrowDown /></IconButton>
                <IconButton kind="ghost" size="sm" align="left" label="Delete" onClick={(e) => { e.stopPropagation(); setConfirmSec(s.id); }}><Close /></IconButton>
              </span>
            </div>
          ))}
        </div>

        <div className="rh-docx-pane">
          <div className="rh-docx-body">
            {secId === SETTINGS || !section
              ? <SettingsPanel content={content} change={change} />
              : <SectionPanel key={section.id} docId={id} content={content} section={section} datasets={datasets} data={data}
                  selBlock={selBlock} setSelBlock={setSelBlock}
                  changeSection={(fn) => changeSection(section.id, fn)}
                  changeBlock={(bid, patch) => changeBlock(section.id, bid, patch)} toast={toast} />}
          </div>
        </div>

        {showPreview && (
          <div className="rh-docx-pane rh-docx-preview">
            <DocPages content={content} params={params} data={data} scale={0.62} onPageCount={setPageCount} />
          </div>
        )}
      </div>
    </div>
  );
}

// --- page setup + parameters --------------------------------------------------------

function SettingsPanel({ content, change }: { content: DocContent; change: (fn: (c: DocContent) => DocContent) => void }) {
  const pg = content.page;
  const setPage = (patch: Partial<DocContent["page"]>) => change((c) => ({ ...c, page: { ...c.page, ...patch } }));
  const custom = typeof pg.size === "object";
  const size = pageSizeOf(pg.size);
  const setParams = (fn: (p: DocParam[]) => DocParam[]) => change((c) => ({ ...c, params: fn(c.params) }));
  return (
    <div>
      <h3 className="cds--type-heading-03" style={{ margin: "0 0 8px" }}>Page setup</h3>
      <div className="rh-docx-row">
        <Select compact label="Paper" value={custom ? "custom" : size.id} style={{ width: 200 }}
            options={[...PAGE_SIZES.map((p) => ({ value: p.id, label: p.label, sub: p.note })), { value: "custom", label: "Custom size" }]}
            onChange={(v) => setPage({ size: v === "custom" ? { widthMm: size.widthMm, heightMm: size.heightMm } : v })} />
        {custom && (<>
          <F label="Width (mm)" type="number" style={{ width: 80 }} value={size.widthMm}
            onChange={(e) => setPage({ size: { widthMm: Number(e.target.value), heightMm: size.heightMm } })} />
          <F label="Height (mm)" type="number" style={{ width: 80 }} value={size.heightMm}
            onChange={(e) => setPage({ size: { widthMm: size.widthMm, heightMm: Number(e.target.value) } })} />
        </>)}
        <Select compact label="Orientation" value={pg.orientation} style={{ width: 130 }} options={[{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]}
            onChange={(v) => setPage({ orientation: v as Orientation })} />
      </div>
      <div className="rh-docx-row">
        {(["top", "right", "bottom", "left"] as const).map((k) => (
          <F key={k} label={`Margin ${k} (mm)`} type="number" min={0} style={{ width: 70 }} value={pg.marginsMm[k]}
              onChange={(e) => setPage({ marginsMm: { ...pg.marginsMm, [k]: Math.max(0, Number(e.target.value) || 0) } })} />
        ))}
      </div>
      <div className="rh-docx-row">
        <Select compact label="Font" value={pg.fontFamily ?? "sans"} style={{ width: 150 }} options={FONT_CHOICES.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(v) => setPage({ fontFamily: v })} />
        <F label="Size (pt)" type="number" min={6} max={24} style={{ width: 70 }} value={pg.fontSizePt ?? 11}
          onChange={(e) => setPage({ fontSizePt: Number(e.target.value) || 11 })} />
      </div>
      <div className="rh-docx-row">
        <F label="Header" style={{ flex: 1 }} value={pg.header ?? ""} placeholder="Running header — {{page}}, {{pages}}, {{param}}" onChange={(e) => setPage({ header: e.target.value })} />
      </div>
      <div className="rh-docx-row">
        <F label="Footer" style={{ flex: 1 }} value={pg.footer ?? ""} placeholder="Page {{page}} of {{pages}}" onChange={(e) => setPage({ footer: e.target.value })} />
      </div>

      <h3 className="cds--type-heading-03" style={{ margin: "24px 0 4px" }}>Parameters</h3>
      {content.params.map((p, i) => (
        <div key={i} className="rh-docx-row">
          <F mono style={{ width: 140 }} placeholder="name" value={p.name}
            onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x)))} />
          <F style={{ width: 160 }} placeholder="Label" value={p.label ?? ""}
            onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <F style={{ width: 160 }} placeholder="Default value" value={p.defaultValue ?? ""}
            onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, defaultValue: e.target.value } : x)))} />
          <Button kind="ghost" size="sm" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <div className="rh-docx-row"><Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setParams((ps) => [...ps, { name: `param${ps.length + 1}`, label: "", defaultValue: "" }])}>Add parameter</Button></div>
    </div>
  );
}

// --- section + blocks -------------------------------------------------------------------

function SectionPanel({ docId, content, section, datasets, data, selBlock, setSelBlock, changeSection, changeBlock, toast }: {
  docId: number; content: DocContent; section: Section; datasets: DatasetDef[]; data: Record<string, BlockData>;
  selBlock: string | null; setSelBlock: (id: string | null) => void;
  changeSection: (fn: (s: Section) => Section) => void;
  changeBlock: (bid: string, patch: Partial<Block>) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const add = (type: BlockType, at?: number) => {
    const b = newBlock(type);
    changeSection((s) => { const a = s.blocks.slice(); a.splice(at ?? a.length, 0, b); return { ...s, blocks: a }; });
    setSelBlock(b.id);
  };
  const move = (i: number, d: number) => changeSection((s) => {
    const a = s.blocks.slice(); const j = i + d;
    if (j < 0 || j >= a.length) return s;
    [a[i], a[j]] = [a[j], a[i]];
    return { ...s, blocks: a };
  });
  const dup = (i: number) => changeSection((s) => {
    const a = s.blocks.slice();
    a.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(a[i])), id: uid() });
    return { ...s, blocks: a };
  });
  const remove = (i: number) => changeSection((s) => ({ ...s, blocks: s.blocks.filter((_, j) => j !== i) }));

  return (
    <div>
      <div className="rh-docx-row" style={{ marginTop: 0, marginBottom: 12 }}>
        <F style={{ flex: 1, fontWeight: 600 }} value={section.title} placeholder="Section title"
          onChange={(e) => changeSection((s) => ({ ...s, title: e.target.value }))} />
        <Select compact label="Orientation" value={section.orientation ?? "inherit"} style={{ width: 150 }}
            options={[{ value: "inherit", label: `Document (${content.page.orientation})` }, { value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]}
            onChange={(v) => changeSection((s) => ({ ...s, orientation: v === "inherit" ? undefined : (v as Orientation) }))} />
        <Chk label="New page" checked={section.newPage !== false} onChange={(e) => changeSection((s) => ({ ...s, newPage: e.target.checked }))} />
        <Chk label="Exclude" checked={!!section.disabled} onChange={(e) => changeSection((s) => ({ ...s, disabled: e.target.checked }))} />
      </div>

      {section.blocks.map((b, i) => (
        <div key={b.id} className={"rh-docx-block" + (selBlock === b.id ? " rh-docx--sel" : "")} onMouseDown={() => setSelBlock(b.id)}>
          <div className="rh-docx-block-h">
            <strong>{BLOCK_LABEL[b.type]}</strong>
            {b.landscape && <Tag size="sm" type="cool-gray">landscape pages</Tag>}
            <span className="rh-docx-acts">
              <IconButton kind="ghost" size="sm" align="left" label="Move up" onClick={() => move(i, -1)}><ArrowUp /></IconButton>
              <IconButton kind="ghost" size="sm" align="left" label="Move down" onClick={() => move(i, 1)}><ArrowDown /></IconButton>
              <Button kind="ghost" size="sm" title="Duplicate" onClick={() => dup(i)}>Copy</Button>
              <IconButton kind="ghost" size="sm" align="left" label="Delete" onClick={() => remove(i)}><Close /></IconButton>
            </span>
          </div>
          <div className="rh-docx-block-b">
            <BlockForm docId={docId} block={b} datasets={datasets} data={data[b.id]} change={(p) => changeBlock(b.id, p)} toast={toast} params={content.params} />
          </div>
        </div>
      ))}

      <div className="rh-docx-add">
        {(Object.keys(BLOCK_LABEL) as BlockType[]).map((t) => (
          <Button key={t} kind="tertiary" size="sm" renderIcon={Add} onClick={() => add(t)}>{BLOCK_LABEL[t]}</Button>
        ))}
      </div>
    </div>
  );
}

const ALIGN_OPTS = [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }, { value: "justify", label: "Justify" }];

function BlockForm({ docId, block, datasets, data, change, toast, params }: {
  docId: number; block: Block; datasets: DatasetDef[]; data?: BlockData; change: (p: Partial<Block>) => void;
  toast: ReturnType<typeof useToast>; params: DocParam[];
}) {
  const common = (
    <div className="rh-docx-row">
      {block.type !== "pageBreak" && <Chk label="Landscape pages" checked={!!block.landscape} onChange={(e) => change({ landscape: e.target.checked })} />}
      {block.type !== "pageBreak" && <Chk label="Start on new page" checked={!!block.pageBreakBefore} onChange={(e) => change({ pageBreakBefore: e.target.checked })} />}
    </div>
  );
  switch (block.type) {
    case "heading":
      return (<>
        <div className="rh-docx-row" style={{ marginTop: 0 }}>
          <Select compact value={String(block.level)} style={{ width: 110 }} options={[{ value: "1", label: "Level 1" }, { value: "2", label: "Level 2" }, { value: "3", label: "Level 3" }]}
            onChange={(v) => change({ level: Number(v) as 1 | 2 | 3 })} />
          <F aria-label="Heading text" style={{ flex: 1, minWidth: 220, fontWeight: 600 }} value={block.text} onChange={(e) => change({ text: e.target.value })} />
          <Select compact value={block.align ?? "left"} style={{ width: 110 }} options={ALIGN_OPTS} onChange={(v) => change({ align: v as "left" })} />
          <Chk label="Not in contents" checked={!!block.noToc} onChange={(e) => change({ noToc: e.target.checked })} />
        </div>
        {common}
      </>);
    case "paragraph":
      return (<>
        <TextArea id={`ta-${block.id}`} labelText="Text" hideLabel rows={5} value={block.text} placeholder="Text — **bold**, *italic*, __underline__, {{param}}" onChange={(e) => change({ text: e.target.value })} />
        <div className="rh-docx-row">
          <Select compact label="Align" value={block.align ?? "left"} style={{ width: 110 }} options={ALIGN_OPTS} onChange={(v) => change({ align: v as "left" })} />
          <F label="Size (pt)" type="number" style={{ width: 70 }} value={block.sizePt ?? ""} placeholder="auto" onChange={(e) => change({ sizePt: e.target.value ? Number(e.target.value) : undefined })} />
          <F label="Indent (mm)" type="number" style={{ width: 70 }} value={block.indentMm ?? ""} onChange={(e) => change({ indentMm: e.target.value ? Number(e.target.value) : undefined })} />
        </div>
        {common}
      </>);
    case "table":
      return <TableForm block={block} datasets={datasets} data={data} change={change} params={params} common={common} />;
    case "image":
      return <ImageForm docId={docId} block={block} change={change} toast={toast} common={common} />;
    case "toc":
      return (<>
        <div className="rh-docx-row" style={{ marginTop: 0 }}>
          <F aria-label="Contents title" value={block.title} onChange={(e) => change({ title: e.target.value })} />
          <Select compact value={String(block.maxLevel)} style={{ width: 150 }} options={[{ value: "1", label: "Level 1 only" }, { value: "2", label: "Levels 1–2" }, { value: "3", label: "Levels 1–3" }]}
            onChange={(v) => change({ maxLevel: Number(v) as 1 | 2 | 3 })} />
        </div>
        {common}
      </>);
    case "spacer":
      return (<>
        <div className="rh-docx-row" style={{ marginTop: 0 }}><F label="Height (mm)" type="number" style={{ width: 80 }} value={block.heightMm} onChange={(e) => change({ heightMm: Math.max(0, Number(e.target.value) || 0) })} /></div>
        {common}
      </>);
    case "divider":
      return common;
    case "pageBreak":
      return <div className="cds--type-label-01 rh-dim">Page break</div>;
  }
}

function TableForm({ block, datasets, data, change, params, common }: {
  block: TableBlock; datasets: DatasetDef[]; data?: BlockData; change: (p: Partial<TableBlock>) => void; params: DocParam[]; common: React.ReactNode;
}) {
  const ds = block.source ? datasets.find((d) => d.id === block.source!.datasetId) : undefined;
  const placeholders = ds ? sqlParams(ds.sqlText) : [];
  const setSource = (patch: Partial<NonNullable<TableBlock["source"]>> | null) =>
    change({ source: patch === null ? undefined : { datasetId: 0, params: {}, ...(block.source ?? {}), ...patch } });
  // Total-row column choices: the bound columns; nothing is totalled until the user picks columns.
  const sumChoices = block.source ? (block.source.columns?.length ? block.source.columns : data?.columns ?? []) : [];
  const sumDefault = block.source && data && !data.error ? defaultTotalColumns(sumChoices, data) : [];
  const sumOn = block.source?.totalColumns ?? sumDefault;

  return (<>
    <div className="rh-docx-row" style={{ marginTop: 0, marginBottom: 8 }}>
      <F style={{ flex: 1 }} placeholder="Table title (optional)" value={block.title ?? ""} onChange={(e) => change({ title: e.target.value })} />
      <F label="Decimals" type="number" min={0} max={6} style={{ width: 60 }} placeholder="Auto" value={block.decimals ?? ""} onChange={(e) => change({ decimals: e.target.value === "" ? undefined : Math.max(0, Math.min(6, Number(e.target.value) || 0)) })} />
      <F label="Font (pt)" type="number" style={{ width: 60 }} value={block.fontSizePt ?? ""} placeholder="auto" onChange={(e) => change({ fontSizePt: e.target.value ? Number(e.target.value) : undefined })} />
    </div>
    <GridEditor grid={block.grid} headerRows={block.headerRows} onChange={(grid) => change({ grid })} onHeaderRows={(headerRows) => change({ headerRows })}
      bodyLocked={!!block.source}
      boundNote={block.source ? (data?.error ? `Data error: ${data.error}` : data ? `${data.rows.length} rows from dataset “${ds?.name ?? block.source.datasetId}”` : "Rows from the bound dataset") : undefined} />
    <div className="rh-docx-row">
      <F label="Column widths" mono style={{ width: 200 }} placeholder="e.g. 3,1,1,1" value={(block.colWidths ?? []).join(",")}
          onChange={(e) => change({ colWidths: e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) })} />
      <Chk label="Keep on one page" checked={!!block.keepWhole} onChange={(e) => change({ keepWhole: e.target.checked })} />
    </div>
    <div className="rh-docx-row">
      <Chk label="Bind to dataset" checked={!!block.source} onChange={(e) => setSource(e.target.checked ? { datasetId: datasets[0]?.id ?? 0, params: {} } : null)} />
      {block.source && (
        <Select compact searchable value={String(block.source.datasetId)} style={{ width: 260 }}
          options={datasets.map((d) => ({ value: String(d.id), label: d.name, sub: d.folder ?? undefined }))}
          onChange={(v) => setSource({ datasetId: Number(v), params: {}, columns: [] })} />
      )}
    </div>
    {block.source && (<>
      {placeholders.map((p) => (
        <div key={p} className="rh-docx-row">
          <span className="cds--type-code-01" style={{ minWidth: 120 }}>${"{"}{p}{"}"}</span>
          <F style={{ width: 220 }} placeholder={params.some((x) => x.name === p) ? `{{${p}}} (default)` : "value or {{param}}"}
            value={block.source!.params[p] ?? ""} onChange={(e) => setSource({ params: { ...block.source!.params, [p]: e.target.value } })} />
        </div>
      ))}
      <div className="rh-docx-row">
        <F label="Columns" mono style={{ width: 300 }} placeholder={data?.columns.join(",") || "all columns"} value={(block.source.columns ?? []).join(",")}
            onChange={(e) => setSource({ columns: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
        <Chk label="Total row" checked={!!block.source.totalRow} onChange={(e) => setSource({ totalRow: e.target.checked })} />
        {block.source.totalRow && <F aria-label="Total label" style={{ width: 120 }} value={block.source.totalLabel ?? "Total"} onChange={(e) => setSource({ totalLabel: e.target.value })} />}
        {block.source.totalRow && sumChoices.length > 1 && (
          <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span className="cds--type-label-01 rh-dim">Sum</span>
            {sumChoices.slice(1).map((c) => {
              const on = sumOn.includes(c);
              return <Button key={c} kind={on ? "primary" : "ghost"} size="sm" aria-pressed={on}
                onClick={() => {
                  const next = on ? sumOn.filter((x) => x !== c) : [...sumOn, c];
                  // An explicit choice is kept as-is; matching the defaults again returns to automatic.
                  const same = next.length === sumDefault.length && next.every((x) => sumDefault.includes(x));
                  setSource({ totalColumns: same ? undefined : next });
                }}>{c}</Button>;
            })}
          </span>
        )}
      </div>
    </>)}
    {common}
  </>);
}

function ImageForm({ docId, block, change, toast, common }: {
  docId: number; block: ImageBlock; change: (p: Partial<ImageBlock>) => void; toast: ReturnType<typeof useToast>; common: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { const a = await docApi.upload(docId, f); change({ url: apiUrl(a.url) }); }
    catch (e) { toast(e instanceof Error ? e.message : "Upload failed", "error"); }
    finally { setBusy(false); }
  };
  return (<>
    <FileUploaderDropContainer accept={["image/*"]} disabled={busy}
      labelText={busy ? "Uploading" : block.url ? "Drop or click to replace the image" : "Drop an image here or click to upload"}
      onAddFiles={(_e: unknown, { addedFiles }: { addedFiles: File[] }) => upload(addedFiles[0])} />
    <div className="rh-docx-row">
      <F style={{ flex: 1 }} placeholder="Caption" value={block.caption ?? ""} onChange={(e) => change({ caption: e.target.value })} />
      <F label="Width %" type="number" min={5} max={100} style={{ width: 70 }} value={block.widthPct} onChange={(e) => change({ widthPct: Math.min(100, Math.max(5, Number(e.target.value) || 50)) })} />
      <Select compact value={block.align ?? "center"} style={{ width: 110 }} options={ALIGN_OPTS.slice(0, 3)} onChange={(v) => change({ align: v as "left" })} />
    </div>
    {common}
  </>);
}
