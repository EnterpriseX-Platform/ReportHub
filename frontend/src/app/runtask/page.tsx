"use client";

import { errMsg } from "@/lib/api";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localClock, localTime } from "@/lib/format";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Button, ContentSwitcher, IconButton, InlineNotification, ProgressBar, Search, SkeletonPlaceholder, Stack,
  StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, Switch, Tag, TextInput, Tile,
} from "@carbon/react";
import { Document, Download, Launch, Play, View } from "@carbon/icons-react";
import { Icon, carbonIcon } from "@/components/Icon";
import st from "@/components/R/r.module.scss";
import { FmtTag, PageHeader, Skeleton } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import { api, fetchOutputBlob } from "@/lib/api";
import type { Category, Job, OutputFile, ParamDef, ParamOption, ReportDetail, ReportSummary, ReportUnit } from "@/lib/types";

type Phase = "idle" | "queued" | "rendering" | "done" | "error";
type Log = { t: string; m: string; s: "info" | "ok" | "error" };

/**
 * Engine whose reports are COMPOSED in the doc builder rather than run with parameters. Run Task
 * frames the doc builder's own editor for them — see {@link DocBuilderEmbed}.
 */
const DOCBUILDER = "docbuilder";
const CSV_PREVIEW_ROWS = 20;

/** File name part of an object key (downloads use this, not the full storage path). */
function baseName(key: string): string {
  return key.split("/").pop() || key;
}

/** First `max` data rows of a CSV (header + rows), RFC 4180 quotes handled; BOM stripped. */
function parseCsvHead(text: string, max: number): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length && out.length <= max; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = ""; out.push(row); row = [];
    } else cell += ch;
  }
  if ((cell || row.length) && out.length <= max) { row.push(cell); out.push(row); }
  return out;
}

/** builtin = no baseUrl: the docId is a ReportHub document (Documents section), edited in this app. */
type DocBuilderCfg = { baseUrl: string; docId: string; builtin: boolean };

const STAGE_LABEL: Record<string, string> = {
  ingress: "Job row committed to the render queue",
  queue: "Queued · awaiting worker",
  worker: "Consumed by worker · acquiring datasource",
  jasper: "Engine fill in progress",
  store: "Storing rendered artifact to object store",
};

function clock(): string {
  return localClock();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function RunTaskPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <RunTask />
    </Suspense>
  );
}

function RunTask() {
  const search = useSearchParams();
  const toast = useToast();
  const [all, setAll] = useState<ReportSummary[]>([]);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [defs, setDefs] = useState<ParamDef[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [fmt, setFmt] = useState<string>("PDF");
  const [priority, setPriority] = useState<string>("normal");
  const [watermark, setWatermark] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<Log[]>([]);
  const [outputs, setOutputs] = useState<OutputFile[]>([]);
  const [priorOutputs, setPriorOutputs] = useState<OutputFile[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<string[][] | null>(null);
  const [docCfg, setDocCfg] = useState<DocBuilderCfg | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => {
    cancelled.current = true;
    if (poll.current) clearTimeout(poll.current);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.reports({ size: 200 }).then((p) => {
      setAll(p.items);
      const code = search.get("code");
      // Select by the URL code directly — selectReport fetches the report by code, so it resolves
      // even for reports outside this first page (the list is capped at 200, sorted updatedAt-desc,
      // but more are registered). Matching against p.items would silently open items[0] for any
      // report beyond the window (e.g. ABC-*), showing the wrong report.
      // Opened from the menu (no ?code=): select nothing, let the user pick. Auto-selecting
      // items[0] (most recently updated) could drop the user straight into a doc-builder composer.
      if (code) selectReport(code);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectReport(code: string) {
    if (poll.current) clearTimeout(poll.current);
    Promise.all([api.report(code), api.reportParameters(code)]).then(([d, ps]) => {
      setDetail(d);
      setDefs(ps);
      setFmt(d.formats[0] ?? "");
      // Run priority starts at the report's own configured priority.
      setPriority(PRIORITIES.some(([v]) => v === d.priority) ? (d.priority as string) : "normal");
      setCsvPreview(null);
      setPhase("idle");
      setLogs([]);
      setOutputs([]);
      setPdfUrl((u) => { if (u) URL.revokeObjectURL(u); return null; });
      // A document-builder report is opened, not run: pull the doc-builder binding out of its render
      // units so the composer can be framed instead of the parameter form.
      setDocCfg(null);
      if (d.engine === DOCBUILDER) {
        api.reportUnits(code).then((us) => setDocCfg(docBuilderCfg(us))).catch(() => setDocCfg(null));
      }
      // Load this report's previously rendered outputs so the user can download the latest
      // without re-running — handy for slow Fetch reports.
      setPriorOutputs([]);
      api.outputs()
        .then((all) => setPriorOutputs(all
          .filter((o) => o.reportCode === code)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
        .catch(() => setPriorOutputs([]));
      // seed defaults
      const init: Record<string, string> = {};
      ps.forEach((p) => { if (p.defaultValue != null) init[p.name] = p.defaultValue; });
      setParams(init);
    }).catch(() => toast("Failed to load report", "error"));
  }

  const log = (m: string, s: Log["s"] = "info") => setLogs((l) => [...l, { t: clock(), m, s }]);

  function setParam(name: string, value: string) {
    setParams((s) => {
      const next = { ...s, [name]: value };
      // reset any params that cascade off this one
      defs.filter((d) => d.dependsOn === name).forEach((child) => { delete next[child.name]; });
      return next;
    });
  }

  async function run() {
    if (!detail) return;
    const missing = defs.filter((d) => (d.requiredOverride ?? d.required) && !params[d.name]);
    if (missing.length) {
      toast(`Required parameters missing: ${missing.map((m) => m.label || m.name).join(", ")}`, "error");
      return;
    }
    if (poll.current) clearTimeout(poll.current);
    cancelled.current = false;
    setOutputs([]);
    setCsvPreview(null);
    setPdfUrl((u) => { if (u) URL.revokeObjectURL(u); return null; });
    setPhase("queued");
    setLogs([{ t: clock(), m: `POST /api/reports/${detail.code}/run · ${fmt}`, s: "info" }]);

    let jobId: string;
    try {
      const res = await api.runReport(detail.code, { format: fmt, params: params, priority, watermark: watermark.trim() || undefined });
      jobId = res.jobId;
      log(`Accepted · jobId ${jobId} · queued with ${priority} priority`);
      if (detail.engine === "fetch") {
        log("This can take a long time — you may leave the screen. The result will be in Output Files.", "info");
        toast("This task takes a long time. You can leave the screen and check Output Files later.", "default");
      }
    } catch (e) {
      setPhase("error");
      log(errMsg(e, "Run request failed"), "error");
      toast("Run failed — check the log", "error");
      return;
    }

    let lastStage = "";
    const tick = async () => {
      if (cancelled.current) return;
      let job: Job;
      try {
        job = await api.job(jobId);
      } catch (e) {
        setPhase("error");
        log(errMsg(e, "Polling failed"), "error");
        toast("Render failed — see log", "error");
        return;
      }
      if (job.stage && job.stage !== lastStage) {
        lastStage = job.stage;
        log(`[${job.stage}] ${STAGE_LABEL[job.stage] ?? job.stage} · ${job.progress}%`);
      }
      if (job.state === "running" || (job.state === "queued" && job.stage !== "queue")) {
        setPhase("rendering");
      }
      if (job.state === "done") {
        setPhase("done");
        log(`Rendered ${job.fmt} · 100% · stored to object bucket`, "ok");
        toast("Report rendered", "ok");
        try {
          // One job can emit SEVERAL artifacts (one per render unit).
          const outs = (await api.outputs()).filter((o) => o.jobId === jobId);
          if (outs.length) {
            setOutputs(outs);
            // "Latest output" shows the file just rendered, not the one from before this run.
            setPriorOutputs((prev) => [...outs, ...prev.filter((p) => !outs.some((o) => o.objectKey === p.objectKey))]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
            outs.forEach((o) => log(`Artifact ${o.objectKey} · ${fmtBytes(o.sizeBytes)}`, "ok"));
            const firstPdf = outs.find((o) => o.fmt === "PDF");
            if (firstPdf) {
              // Real preview: pull the actual artifact and embed it.
              const blob = await fetchOutputBlob(firstPdf.objectKey);
              const url = URL.createObjectURL(blob);
              if (!cancelled.current) setPdfUrl(url);
            } else {
              // Non-PDF (XLSX, CSV, DOCX): show the result in place (artifact list below); CSV also
              // gets a preview of its first rows. Downloading stays a click away.
              const csv = outs.find((o) => o.fmt === "CSV");
              if (csv && !cancelled.current) {
                const text = await (await fetchOutputBlob(csv.objectKey)).text();
                if (!cancelled.current) setCsvPreview(parseCsvHead(text, CSV_PREVIEW_ROWS));
              }
            }
          }
        } catch { /* preview/download link optional */ }
        return;
      }
      if (job.state === "error") {
        setPhase("error");
        log(job.errorMessage ? `Render failed: ${job.errorMessage}` : "Render failed — job marked error by worker", "error");
        toast("Render failed — see log", "error");
        return;
      }
      if (job.state === "cancelled") {
        setPhase("error");
        log("Job cancelled", "error");
        toast("Job cancelled", "default");
        return;
      }
      poll.current = setTimeout(tick, 1200);
    };
    poll.current = setTimeout(tick, 700);
  }

  async function download(o: OutputFile) {
    try {
      await api.downloadOutput(o.objectKey, baseName(o.objectKey));
    } catch (e) {
      toast(errMsg(e, "Download failed"), "error");
    }
  }

  const busy = phase === "queued" || phase === "rendering";

  // Document-builder reports have no parameters and no run step here — the whole screen is the doc
  // builder's composer, where the user edits the document and exports it.
  if (detail?.engine === DOCBUILDER) {
    return (
      <div className="fade-in">
        <PageHeader
          title="Run Task"
          sub="Compose the document and export it as PDF from the document builder"
          actions={<>
            <div style={{ width: 300, maxWidth: "100%" }}><ReportPicker all={all} current={detail} onPick={selectReport} hideLabel /></div>
            <div style={{ width: 180 }}>
              <TextInput id="rt-wm-db" labelText="Watermark (optional)" hideLabel size="lg" value={watermark} maxLength={200}
                         onChange={(e) => setWatermark(e.target.value)} placeholder="Watermark (optional)" />
            </div>
            <DocBuilderExport report={detail} priority={priority} watermark={watermark} />
          </>}
        />
        <DocBuilderEmbed report={detail} cfg={docCfg} />
      </div>
    );
  }

  const PRIORITIES = [["high", "High"], ["normal", "Normal"], ["low", "Low"]] as const;
  const formats = detail?.formats ?? ["PDF"];
  return (
    <div className="fade-in">
      <PageHeader title="Run Task" sub="Run a registered report with parameters and inspect the output" />

      <div className={st.runGrid}>
        <Tile className={st.runConfig}>
          <h2 className="cds--type-heading-compact-02" style={{ marginBottom: "var(--cds-spacing-05)" }}>Run configuration</h2>
          <Stack gap={6}>
            {/* report selection as a search-suggest combobox — frees the left column so Preview can expand */}
            <ReportPicker all={all} current={detail} onPick={selectReport} />
            <h3 className="cds--type-heading-compact-01" style={{ borderTop: "1px solid var(--cds-border-subtle-01)", paddingTop: "var(--cds-spacing-05)" }}>Parameters</h3>
            {/* No report picked yet: nothing to say about parameters. */}
            {!detail && <p className="cds--type-body-compact-01 rh-dim">Pick a report above to see its parameters</p>}
            {detail && defs.length === 0 && <p className="cds--type-body-compact-01 rh-dim">No parameters assigned to this report yet</p>}
            {defs.map((p) => (
              <ParamField
                key={p.name}
                def={p}
                value={params[p.name] ?? ""}
                parentValue={p.dependsOn ? params[p.dependsOn] ?? "" : undefined}
                onChange={(v) => setParam(p.name, v)}
              />
            ))}
            {detail?.engine === "other" ? (
              /* "Other" = information-only engine: nothing to render, so no format picker / Run task button. */
              <InlineNotification kind="info" lowContrast hideCloseButton title="Information only"
                subtitle="An Other report renders nothing, so there is no Run task button. See its App module details on the Overview tab." />
            ) : (
              <>
                <div>
                  <div className="cds--label">Output format</div>
                  <ContentSwitcher size="md" selectedIndex={Math.max(0, formats.indexOf(fmt))} onChange={({ name }) => setFmt(String(name))}>
                    {formats.map((f) => <Switch key={f} name={f} text={f} />)}
                  </ContentSwitcher>
                </div>
                <div>
                  <div className="cds--label">Priority</div>
                  <ContentSwitcher size="md" selectedIndex={Math.max(0, PRIORITIES.findIndex(([v]) => v === priority))} onChange={({ name }) => setPriority(String(name))}>
                    {PRIORITIES.map(([v, l]) => <Switch key={v} name={v} text={l} />)}
                  </ContentSwitcher>
                </div>
                <TextInput id="rt-wm" labelText="Watermark (optional)" value={watermark} maxLength={200} onChange={(e) => setWatermark(e.target.value)} placeholder="e.g. DRAFT" />
                <Button kind="primary" size="lg" renderIcon={busy ? undefined : Play} onClick={run} disabled={busy || !detail} style={{ maxWidth: "none", width: "100%" }}>
                  {busy ? "Rendering…" : "Run task"}
                </Button>
                {detail?.engine === "fetch" && (
                  <InlineNotification kind="info" lowContrast hideCloseButton title="Long-running task"
                    subtitle="You can leave the screen after Run task — the result lands in Output Files." />
                )}
                {priorOutputs.length > 0 && (
                  <div>
                    <div className="cds--label">Latest output</div>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)" }}>
                      <FmtTag f={priorOutputs[0].fmt} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="cds--type-code-01 rh-ellipsis">{priorOutputs[0].objectKey.split("/").pop()}</div>
                        <div className="cds--type-helper-text-01 rh-dim">{fmtBytes(priorOutputs[0].sizeBytes)} · {localTime(priorOutputs[0].createdAt)}</div>
                      </div>
                      <IconButton kind="ghost" size="sm" align="left" label="Download latest output" onClick={() => download(priorOutputs[0])}><Download /></IconButton>
                    </div>
                  </div>
                )}
              </>
            )}
          </Stack>
        </Tile>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--cds-spacing-05)", minWidth: 0 }}>
          <div className={st.previewBox}>
            <div className={st.previewHead}>
              <View size={16} style={{ fill: "var(--cds-icon-secondary)" }} />
              <h2 className="cds--type-heading-compact-01" style={{ flex: 1 }}>Preview</h2>
              {phase === "done" && (
                <span className="cds--type-code-01 rh-dim">
                  {outputs.length > 1 ? `${outputs.length} artifacts` : outputs[0] ? `${outputs[0].fmt} · ${fmtBytes(outputs[0].sizeBytes)}` : `${fmt} · artifact`}
                </span>
              )}
            </div>
            <div className={st.previewBody} style={{ padding: pdfUrl ? 0 : "var(--cds-spacing-07)", placeItems: pdfUrl ? "stretch" : "center" }}>
              {phase === "idle" && <p className="cds--type-body-compact-01 rh-dim">Configure parameters and run to preview.</p>}
              {busy && <RenderingState phase={phase} />}
              {phase === "error" && (
                <InlineNotification kind="error" lowContrast hideCloseButton title="Render failed" subtitle="See the run log below for details." />
              )}
              {phase === "done" && detail && (
                pdfUrl
                  ? <iframe title="artifact" src={pdfUrl} style={{ width: "100%", height: "calc(100vh - 210px)", border: 0, background: "#525659" }} />
                  : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--cds-spacing-03)" }}>
                      <Tag type="green" size="md">rendered {outputs.length > 1 ? `${outputs.length} artifacts` : "artifact"}</Tag>
                      {outputs.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cds-spacing-03)", justifyContent: "center" }}>
                          {outputs.map((o) => (
                            <Button key={o.objectKey} kind="tertiary" size="md" renderIcon={Download} onClick={() => download(o)}>
                              {baseName(o.objectKey)} · {fmtBytes(o.sizeBytes)}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <p className="cds--type-body-compact-01 rh-dim">Artifacts are available from the Output Files page</p>
                      )}
                      {csvPreview && csvPreview.length > 0 && (
                        <div style={{ width: "100%", maxWidth: "100%", overflow: "auto", marginTop: "var(--cds-spacing-05)" }}>
                          <table className="cds--data-table cds--data-table--sm" aria-label="CSV preview">
                            <thead><tr>{csvPreview[0].map((h, i) => <th key={i}><div className="cds--table-header-label">{h}</div></th>)}</tr></thead>
                            <tbody>
                              {csvPreview.slice(1).map((row, ri) => (
                                <tr key={ri}>{csvPreview[0].map((_, ci) => <td key={ci}>{row[ci] ?? ""}</td>)}</tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="cds--type-helper-text-01 rh-dim" style={{ marginTop: "var(--cds-spacing-02)" }}>
                            First {Math.max(0, csvPreview.length - 1)} rows
                          </div>
                        </div>
                      )}
                    </div>
                  )
              )}
            </div>
          </div>

          {outputs.length > 0 && (
            <Tile>
              <div className="rh-tile-head">
                <h3 className="cds--type-heading-compact-01" style={{ flex: 1 }}>Artifacts ({outputs.length})</h3>
                <span className="cds--type-helper-text-01 rh-dim">one file per render unit</span>
                <Button kind="ghost" size="sm" renderIcon={View} as={Link} href="/outputs">Open Output Files</Button>
              </div>
              <StructuredListWrapper isCondensed className="rh-slist" aria-label="Artifacts">
                <StructuredListBody>
                  {outputs.map((o) => (
                    <StructuredListRow key={o.objectKey}>
                      <StructuredListCell className="cds--type-code-01" style={{ wordBreak: "break-all" }} title={o.objectKey}>{baseName(o.objectKey)}</StructuredListCell>
                      <StructuredListCell noWrap className="rh-dim">{fmtBytes(o.sizeBytes)}</StructuredListCell>
                      <StructuredListCell noWrap><FmtTag f={o.fmt} /></StructuredListCell>
                      <StructuredListCell noWrap><Button kind="ghost" size="sm" renderIcon={Download} onClick={() => download(o)}>Download</Button></StructuredListCell>
                    </StructuredListRow>
                  ))}
                </StructuredListBody>
              </StructuredListWrapper>
            </Tile>
          )}

          {logs.length > 0 && (
            <Tile>
              <div className="rh-tile-head">
                <h3 className="cds--type-heading-compact-01" style={{ flex: 1 }}>Run log</h3>
                {phase === "done" && <Tag type="green" size="sm">success</Tag>}
                {phase === "error" && <Tag type="red" size="sm">failed</Tag>}
                {busy && <Tag type="blue" size="sm">{phase}</Tag>}
                <Button kind="ghost" size="sm" renderIcon={carbonIcon("queue")} as={Link} href="/queue">Queue Monitor</Button>
              </div>
              <div className="cds--type-code-01" style={{ padding: "var(--cds-spacing-04)", lineHeight: 1.9, maxHeight: 180, overflow: "auto", background: "var(--cds-layer-02)" }}>
                {logs.map((l, i) => <div key={i} style={{ display: "flex", gap: "var(--cds-spacing-04)" }}><span className="rh-dim">{l.t}</span><span style={{ color: l.s === "error" ? "var(--cds-text-error)" : l.s === "ok" ? "var(--cds-support-success)" : "var(--cds-text-primary)" }}>{l.m}</span></div>)}
              </div>
            </Tile>
          )}
        </div>
      </div>

    </div>
  );
}

/**
 * Pull the doc-builder binding out of a report's render units. The docbuilder engine declares
 * {@code baseUrl}/{@code docId} as reportProps, so they live in the unit's configJson — the same
 * place the register wizard and the unit config form write them.
 */
function docBuilderCfg(units: ReportUnit[]): DocBuilderCfg | null {
  for (const u of units) {
    if (!u.enabled || u.engine !== DOCBUILDER || !u.configJson) continue;
    try {
      const c = JSON.parse(u.configJson) as { baseUrl?: string; docId?: string };
      if (!c.docId?.trim()) continue;
      // No baseUrl = the engine's built-in default: export a ReportHub document through the bundled exporter.
      if (!c.baseUrl?.trim()) return { baseUrl: process.env.NEXT_PUBLIC_BASE_PATH || "", docId: c.docId.trim(), builtin: true };
      return { baseUrl: c.baseUrl.replace(/\/+$/, ""), docId: c.docId.trim(), builtin: false };
    } catch { /* malformed config — try the next unit */ }
  }
  return null;
}

/**
 * Export the framed book through Report Studio instead of the doc builder's own button.
 *
 * <p>Why not just use the doc builder's button: it renders synchronously, so a gateway timeout can
 * cut off a book that takes minutes to build.
 * Going through Report Studio puts the render on the queue, where it is bounded only by the
 * engine's own timeout; the artifact also lands in Output Files, so leaving this screen is safe.
 */
function DocBuilderExport({ report, priority, watermark }: { report: ReportDetail; priority: string; watermark: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const { jobId } = await api.runReport(report.code, {
        // Only declared formats are accepted (400 otherwise).
        format: report.formats.includes("PDF") ? "PDF" : report.formats[0],
        params: {}, priority, watermark: watermark.trim() || undefined,
      });
      toast("Generating the file — a large document takes several minutes. You can leave the screen; the result will be in Output Files.", "default");
      // Poll for up to 20 min. The job outlives this page, so a timeout here only stops WATCHING —
      // the artifact still shows up in Output Files.
      const deadline = Date.now() + 20 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const job = await api.job(jobId);
        if (job.state === "done") break;
        if (job.state === "error") throw new Error("Could not generate the file — see Queue Monitor for details");
        if (job.state === "cancelled") throw new Error("The job was cancelled");
        if (Date.now() > deadline) throw new Error("Still generating — pick the file up from Output Files later");
      }
      const outs = (await api.outputs()).filter((o) => o.jobId === jobId);
      if (!outs.length) throw new Error("The job finished but no output file was found");
      await api.downloadOutput(outs[0].objectKey, baseName(outs[0].objectKey) || `${report.code}.pdf`);
      toast("File downloaded", "ok");
    } catch (e) {
      toast(errMsg(e, "Export failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button kind="primary" renderIcon={busy ? undefined : Download} onClick={go} disabled={busy} title="Render the PDF through the Report Studio queue, then download it">
      {busy ? "Generating…" : "Export PDF"}
    </Button>
  );
}

/**
 * The doc builder's own composer, framed in place of the parameter form. A docbuilder report is COMPOSED,
 * not parameterised: the section tree, per-section fields and live preview all live in the doc builder, so
 * Run Task embeds that editor rather than reimplementing it.
 *
 * <p>Once the app is actually up it draws its OWN title bar — book name, author/section/form,
 * save state — so ours would be a second copy of the same thing. We therefore ask the frame what it
 * loaded (same origin, so we can look) and drop our header when the composer is there. If the gateway
 * bounced it to the login page instead, the header stays: that is when its URL and the open-in-a-new-tab
 * escape hatch are the only things that help.
 */
function DocBuilderEmbed({ report, cfg }: { report: ReportDetail; cfg: DocBuilderCfg | null }) {
  const [appUp, setAppUp] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  /**
   * The doc builder can bounce back to its document list on its own: a department guard, a missing
   * document (404), or internal navigation that drops the query string (role reverts to filler).
   * This screen is opened for one document only, so landing on the list counts as a failure.
   *
   * Same origin, so the inner path is readable: steer back into the document at most twice,
   * then give up, otherwise a document that genuinely cannot open would loop forever.
   */
  const [frameState, setFrameState] = useState<"ok" | "listed" | "login">("ok");
  const retries = useRef(0);

  // React mounts inside the frame after its load event, so probe for a short while rather than once.
  const probe = useCallback(() => {
    const f = frameRef.current;
    if (!f) return false;
    try {
      const d = f.contentDocument;
      if (!d) return false;
      if (/\/idp\/realms|\/oauth2\//.test(d.location.href)) return false; // gateway login page
      const root = d.querySelector("#root");
      return !!root && root.children.length > 0;
    } catch {
      return false; // cross-origin: can't tell, so keep our header
    }
  }, []);

  useEffect(() => {
    if (!cfg) return;
    let tries = 0;
    const t = setInterval(() => {
      if (probe()) { setAppUp(true); clearInterval(t); }
      else if (++tries > 40) clearInterval(t); // ~20s then give up and keep the header
    }, 500);
    return () => clearInterval(t);
  }, [cfg, probe]);

  if (!cfg) {
    return (
      <InlineNotification kind="error" lowContrast hideCloseButton title="No document bound yet" style={{ maxWidth: "none" }}
        subtitle={`Set a document id (docId) on a render unit of ${report.code} in Report Registry › Config.`} />
    );
  }
  // Open the doc builder in the embed mode it already supports for host apps: no brand/home button,
  // no role chip, no back control (Run Task is the way out) and — since our own Export PDF
  // sits in the page header and renders through the queue — no second export button.
  // role=manager is required: the doc builder reads role from the query string (default filler),
  // and a filler whose department differs from the document's is bounced to the document list.
  // role=manager skips that guard and needs no department.
  // Built-in: the ReportHub document editor, framed (the shell hides itself inside a frame).
  const editorUrl = cfg.builtin
    ? `${cfg.baseUrl}/documents/${encodeURIComponent(cfg.docId)}`
    : `${cfg.baseUrl}/doc/${encodeURIComponent(cfg.docId)}`
      + `?embed=1&hideBack=1&hideExport=1&role=manager&backLabel=${encodeURIComponent("Back")}`;
  function onFrameLoad() {
    const w = frameRef.current?.contentWindow;
    if (!w) return;
    let path: string;
    // Cross-origin means we were sent to the identity provider: not signed in yet.
    try { path = w.location.pathname; } catch { setFrameState("login"); return; }
    if (path.startsWith("/idp/")) { setFrameState("login"); return; }
    if (path.includes(cfg!.builtin ? "/documents/" : "/doc/")) { retries.current = 0; setFrameState("ok"); return; }
    if (retries.current >= 2) { setFrameState("listed"); return; }
    retries.current += 1;
    try { w.location.replace(editorUrl); } catch { setFrameState("listed"); }
  }

  return (
    <div className={st.previewBox}>
      {frameState !== "ok" && (
        <InlineNotification kind="warning" lowContrast hideCloseButton style={{ maxWidth: "none" }}
          title={frameState === "login" ? "Not signed in" : "Document did not open"}
          subtitle={frameState === "login"
            ? "Sign in first, then come back to this screen"
            : "The doc builder did not open the selected document, and steering back to it failed"}>
          <div style={{ marginTop: "var(--cds-spacing-03)" }}>
            {frameState === "login"
              ? <Button kind="primary" size="sm" as="a" href={`/oauth2/start?rd=${encodeURIComponent((process.env.NEXT_PUBLIC_BASE_PATH || "") + "/runtask")}`} target="_top">Sign in</Button>
              : <Button kind="tertiary" size="sm" renderIcon={Launch} as="a" href={editorUrl} target="_blank" rel="noreferrer">Open in new tab</Button>}
          </div>
        </InlineNotification>
      )}
      {!appUp && (
        <div className={st.previewHead}>
          <Document size={16} style={{ fill: "var(--cds-icon-secondary)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 className="cds--type-heading-compact-01">{report.name}</h3>
            <div className="cds--type-code-01 rh-dim rh-ellipsis">{editorUrl}</div>
          </div>
          <Button kind="ghost" size="sm" renderIcon={Launch} as="a" href={editorUrl} target="_blank" rel="noreferrer">Open in new tab</Button>
        </div>
      )}
      <iframe
        ref={frameRef}
        title={report.name}
        src={editorUrl}
        onLoad={onFrameLoad}
        style={{ width: "100%", height: appUp ? "calc(100vh - 150px)" : "calc(100vh - 210px)", border: 0, display: "block", background: "var(--cds-layer-02)" }}
      />
    </div>
  );
}

/**
 * Report search-suggest combobox. Lives inside Run configuration (no left column), so typing filters
 * the registered reports and picking one loads it. Keyboard: ↑/↓ to move, Enter to pick, Esc to close.
 */
/** Recently picked reports — kept in the user's browser, no backend table needed. */
const RECENT_KEY = "rs.runtask.recent";
const RECENT_MAX = 8;

type RecentItem = { code: string; name: string };

function readRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is RecentItem => !!x && typeof (x as RecentItem).code === "string")
      .slice(0, RECENT_MAX);
  } catch {
    return [];                                   // private mode / corrupt value = nothing yet
  }
}

function pushRecent(item: RecentItem): RecentItem[] {
  const next = [item, ...readRecent().filter((r) => r.code !== item.code)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* quota full: ignore */ }
  return next;
}

/**
 * Report picker for Run Task: a browsable panel — categories on the left (same as Report Registry
 * and Output Files), the reports of the selected category on the right, and the user's recent runs
 * on top. Typing searches every report on the server, not just the first 200 loaded.
 */
function ReportPicker({ all, current, onPick, hideLabel }: {
  all: ReportSummary[]; current: ReportDetail | null; onPick: (code: string) => void; hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  /** "recent" · "all" · category id */
  const [tab, setTab] = useState<string>("recent");
  const [cats, setCats] = useState<Category[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [catRows, setCatRows] = useState<ReportSummary[] | null>(null);
  const [loadingCat, setLoadingCat] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setQ(""); }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Read recent items after mount only — reading during SSR render causes a hydration mismatch.
  useEffect(() => { setRecent(readRecent()); }, []);

  useEffect(() => {
    api.categories().then(setCats).catch(() => setCats([]));
  }, []);

  // With no recent runs, start on "All reports" so the panel is not empty.
  useEffect(() => {
    if (open && recent.length === 0 && tab === "recent") setTab("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reports of the selected category — fetched per category rather than loading everything.
  useEffect(() => {
    if (!open || q.trim() || tab === "recent" || tab === "all") { setCatRows(null); return; }
    let live = true;
    setLoadingCat(true);
    api.reports({ category: tab, size: 200 })
      .then((p) => { if (live) setCatRows(p.items); })
      .catch(() => { if (live) setCatRows([]); })
      .finally(() => { if (live) setLoadingCat(false); });
    return () => { live = false; };
  }, [open, tab, q]);

  // Search on the server: `all` holds only the first 200 reports (updatedAt desc), so filtering
  // locally would report "no match" for reports that exist outside that window.
  const [remote, setRemote] = useState<ReportSummary[] | null>(null);
  const [seeking, setSeeking] = useState(false);
  const needle = q.trim().toLowerCase();

  useEffect(() => {
    const term = q.trim();
    if (!term) { setRemote(null); setSeeking(false); return; }
    let live = true;
    setSeeking(true);
    const t = setTimeout(() => {
      api.reports({ q: term, size: 50 })
        .then((p) => { if (live) setRemote(p.items); })
        .catch(() => { if (live) setRemote([]); })
        .finally(() => { if (live) setSeeking(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const byCode = useMemo(() => {
    const m = new Map<string, ReportSummary>();
    for (const r of [...all, ...(catRows ?? []), ...(remote ?? [])]) m.set(r.code, r);
    return m;
  }, [all, catRows, remote]);

  /** Rows the panel shows now — search results while searching, otherwise the selected tab. */
  const list: ReportSummary[] = useMemo(() => {
    if (needle) {
      const local = all.filter((r) => r.name.toLowerCase().includes(needle)
        || r.code.toLowerCase().includes(needle)
        || (r.categoryRef ?? "").toLowerCase().includes(needle));
      // Server results first, topped up with local matches so something shows while waiting.
      return [...(remote ?? []), ...local.filter((r) => !(remote ?? []).some((x) => x.code === r.code))].slice(0, 60);
    }
    if (tab === "recent") {
      return recent.map((r) => byCode.get(r.code)
        ?? ({ code: r.code, name: r.name, id: r.code, categoryRef: null } as unknown as ReportSummary));
    }
    if (tab === "all") return all.slice(0, 200);
    return catRows ?? [];
  }, [needle, remote, all, tab, recent, catRows, byCode]);

  function pick(code: string) {
    const row = byCode.get(code);
    setRecent(pushRecent({ code, name: row?.name ?? code }));
    onPick(code);
    setOpen(false); setQ(""); setHi(0);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setOpen(false); setQ(""); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, list.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter" && open && list[hi]) { e.preventDefault(); pick(list[hi].code); }
  }

  const tabs: { key: string; label: string; n?: number }[] = [
    { key: "recent", label: "Recent runs", n: recent.length },
    { key: "all", label: "All reports", n: cats.reduce((a, c) => a + c.registered, 0) || undefined },
    ...cats.map((c) => ({ key: c.id, label: c.name, n: c.registered })),
  ];

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <Search
        size="lg"
        labelText="Report"
        placeholder={current ? current.name : "Search a report by name or code…"}
        value={open ? q : (current?.name ?? "")}
        onChange={(e) => { setQ(typeof e === "string" ? e : e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => { setOpen(true); setQ(""); }}
        onKeyDown={onKey}
        onClear={() => { setQ(""); }}
        closeButtonLabelText="Clear"
        role="combobox"
        aria-expanded={open}
      />
      {!hideLabel && current && !open && (
        <div className="cds--type-code-01 rh-dim" style={{ marginTop: "var(--cds-spacing-02)" }}>{current.code}</div>
      )}
      {open && (
        /* Panel is wider than the input — long report names would be cut on every line at 360px. */
        <div className={st.pickPanel}>
          <div className={st.pickGrid}>
            {/* Left: categories, browsable without knowing report names. Grid children default to
                min-height: auto, so both sides need minHeight: 0 for overflow-y to scroll. */}
            <div className={st.pickCats}>
              {tabs.map((t) => {
                const on = tab === t.key && !needle;
                return (
                  <button type="button" key={t.key} onClick={() => { setTab(t.key); setQ(""); setHi(0); }}
                          title={t.label} className={`${st.pickItem} ${on ? st.pickOn : ""}`} style={{ opacity: needle ? 0.5 : 1 }}>
                    <Icon name={t.key === "recent" ? "clock" : t.key === "all" ? "grid" : "folder"} size={16}
                          style={{ flex: "none", color: "var(--cds-icon-secondary)" }} />
                    <span className="cds--type-body-compact-01" style={{ flex: 1, minWidth: 0, textAlign: "left" }}>{t.label}</span>
                    {t.n != null && <span className="cds--type-label-01 rh-dim" style={{ flex: "none" }}>{t.n}</span>}
                  </button>
                );
              })}
            </div>

            {/* Right: reports in the selected category (or search results). */}
            <div className={st.pickList} role="listbox">
              {loadingCat && !needle && (
                <Skeleton rows={4} />
              )}
              {list.length === 0 && !loadingCat && (
                <p className="cds--type-body-compact-01 rh-dim" style={{ padding: "var(--cds-spacing-04)" }}>
                  {needle ? (seeking ? "Searching…" : `No reports match “${q}”`)
                    : tab === "recent" ? "No reports run from this browser yet"
                    : "No reports in this category"}
                </p>
              )}
              {list.map((r, i) => {
                const on = r.code === current?.code;
                const active = i === hi;
                return (
                  <button type="button" role="option" aria-selected={on} key={r.code} onClick={() => pick(r.code)} onMouseEnter={() => setHi(i)}
                          title={r.name} className={`${st.pickItem} ${active ? st.pickHi : ""} ${on ? st.pickOn : ""}`} style={{ alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                      {/* Wrap rather than ellipsize: many names differ only at the end. */}
                      <div className="cds--type-body-compact-01" style={{ fontWeight: on ? 600 : undefined }}>{r.name}</div>
                      <div className="cds--type-code-01 rh-dim">
                        {r.code}{r.categoryRef ? ` · ${r.categoryRef}` : ""}{r.formats?.length ? ` · ${r.formats.join(" ")}` : ""}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One parameter input. Query-sourced params load their options from the API;
 * a param with dependsOn re-fetches whenever the parent's value changes (cascade).
 */
function ParamField({ def, value, parentValue, onChange }: {
  def: ParamDef;
  value: string;
  parentValue?: string;
  onChange: (v: string) => void;
}) {
  const [options, setOptions] = useState<ParamOption[]>(def.staticOptions ?? []);
  const [loading, setLoading] = useState(false);

  const isSelect = def.sourceType === "query" || def.sourceType === "sql" || (def.staticOptions?.length ?? 0) > 0 || def.type === "boolean" || def.type === "enum";
  const waitingForParent = !!def.dependsOn && !parentValue;

  const load = useCallback(() => {
    if (def.sourceType === "static" && (def.staticOptions?.length ?? 0) > 0) {
      setOptions(def.staticOptions);
      return;
    }
    if (!isSelect) return;
    if (waitingForParent) { setOptions([]); return; }
    setLoading(true);
    api.paramOptions(def.name, def.dependsOn ? parentValue : undefined)
      .then(setOptions)
      .catch(() => setOptions([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.name, def.sourceType, parentValue, waitingForParent]);

  useEffect(() => { load(); }, [load]);

  const label = (def.label || def.name) + ((def.requiredOverride ?? def.required) ? " *" : "") + (def.dependsOn ? ` ← ${def.dependsOn}` : "");
  return isSelect ? (
    <Select
      label={label}
      note={def.type}
      value={value}
      disabled={waitingForParent || loading}
      onChange={onChange}
      placeholder={waitingForParent ? `Select ${def.dependsOn} first` : "— select —"}
      options={options.map((o) => ({ value: o.value, label: o.label }))}
    />
  ) : (
    <TextInput
      id={`rt-p-${def.name}`}
      labelText={label}
      helperText={def.type}
      className="rh-mono"
      placeholder={def.defaultValue ?? "—"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function RenderingState({ phase }: { phase: Phase }) {
  return (
    <div style={{ width: "min(320px, 100%)", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--cds-spacing-05)" }}>
      <SkeletonPlaceholder style={{ width: 80, height: 104 }} />
      <div style={{ width: "100%" }}><ProgressBar label={phase === "queued" ? "Queued…" : "Engine rendering…"} /></div>
    </div>
  );
}
