"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Fmts } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import { api, fetchOutputBlob } from "@/lib/api";
import type { Job, OutputFile, ParamDef, ParamOption, ReportDetail, ReportSummary } from "@/lib/types";

type Phase = "idle" | "queued" | "rendering" | "done" | "error";
type Log = { t: string; m: string; s: "info" | "ok" | "error" };

const STAGE_LABEL: Record<string, string> = {
  ingress: "Produced to kafka topic report.jobs",
  queue: "Queued on Kafka · awaiting worker",
  worker: "Consumed by worker · acquiring datasource",
  jasper: "Engine fill in progress",
  store: "Storing rendered artifact to object store",
};

function clock(): string {
  return new Date().toISOString().slice(11, 23);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function RunTaskPage() {
  return (
    <Suspense fallback={<div className="empty"><span className="spin" /></div>}>
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
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<Log[]>([]);
  const [outputs, setOutputs] = useState<OutputFile[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
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
      const initial = (code && p.items.find((r) => r.code === code)) || p.items[0];
      if (initial) selectReport(initial.code);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectReport(code: string) {
    if (poll.current) clearTimeout(poll.current);
    Promise.all([api.report(code), api.reportParameters(code)]).then(([d, ps]) => {
      setDetail(d);
      setDefs(ps);
      setFmt(d.formats[0] ?? "PDF");
      setPhase("idle");
      setLogs([]);
      setOutputs([]);
      setPdfUrl((u) => { if (u) URL.revokeObjectURL(u); return null; });
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
    setPdfUrl((u) => { if (u) URL.revokeObjectURL(u); return null; });
    setPhase("queued");
    setLogs([{ t: clock(), m: `POST /api/reports/${detail.code}/run · ${fmt}`, s: "info" }]);

    let jobId: string;
    try {
      const res = await api.runReport(detail.code, { format: fmt, params: params, priority: "normal" });
      jobId = res.jobId;
      log(`Accepted · jobId ${jobId} · produced to topic report.jobs`);
    } catch (e) {
      setPhase("error");
      log(e instanceof Error ? e.message : "Run request failed", "error");
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
        log(e instanceof Error ? e.message : "Polling failed", "error");
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
            outs.forEach((o) => log(`Artifact ${o.objectKey} · ${fmtBytes(o.sizeBytes)}`, "ok"));
            const firstPdf = outs.find((o) => o.fmt === "PDF");
            if (firstPdf) {
              // Real preview: pull the actual artifact and embed it.
              const blob = await fetchOutputBlob(firstPdf.objectKey);
              const url = URL.createObjectURL(blob);
              if (!cancelled.current) setPdfUrl(url);
            } else {
              // Non-PDF (XLSX, CSV, DOCX): auto-download the first artifact.
              const first = outs[0];
              if (first && !cancelled.current) {
                await api.downloadOutput(first.objectKey, first.objectKey.split("/").pop() ?? first.objectKey);
              }
            }
          }
        } catch { /* preview/download link optional */ }
        return;
      }
      if (job.state === "error") {
        setPhase("error");
        log("Render failed — job marked error by worker", "error");
        toast("Render failed — see log", "error");
        return;
      }
      poll.current = setTimeout(tick, 1200);
    };
    poll.current = setTimeout(tick, 700);
  }

  async function download(o: OutputFile) {
    try {
      await api.downloadOutput(o.objectKey, o.objectKey);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Download failed", "error");
    }
  }

  const busy = phase === "queued" || phase === "rendering";

  return (
    <div className="fade-in">
      <div className="page-head">
        <div><h1 className="page-title">Run Task</h1><div className="page-sub">Run a registered report with parameters and inspect the output</div></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ position: "sticky", top: 0 }}>
          <div className="card-head"><Icon name="tester" size={17} style={{ color: "var(--accent)" }} /><h3>Run configuration</h3></div>
          <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 15 }}>
            {/* report selection moved here as a search-suggest combobox — frees the left column so Preview can expand */}
            <ReportPicker all={all} current={detail} onPick={selectReport} />
            <div className="divider" style={{ margin: "2px 0" }} />
            <div className="section-label" style={{ margin: 0 }}>Parameters</div>
            {defs.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-4)" }}>No parameters assigned to this report yet — add them from the Parameters menu</div>}
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
              <div style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "11px 13px", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--line)", fontSize: 12, color: "var(--ink-3)", lineHeight: 1.6 }}>
                <Icon name="doc" size={16} style={{ color: "var(--ink-4)", flex: "none", marginTop: 1 }} />
                <span><b>Other</b>-type reports (data only) do not render a file, so there is no Run task button — see the App module info on the Overview tab</span>
              </div>
            ) : (
              <>
                <div className="field"><label>Output format</label>
                  <div style={{ display: "flex", gap: 7 }}>
                    {(detail?.formats ?? ["PDF"]).map((f) => (
                      <button key={f} className="btn sm" style={{ borderColor: fmt === f ? "var(--accent)" : undefined, background: fmt === f ? "var(--accent-weak)" : undefined, color: fmt === f ? "var(--accent)" : undefined }} onClick={() => setFmt(f)}>{f}</button>
                    ))}
                  </div>
                </div>
                <button className="btn primary" style={{ height: 42 }} onClick={run} disabled={busy || !detail}>
                  {busy ? <><span className="spin" />Rendering…</> : <><Icon name="play" size={16} />Run task</>}
                </button>
              </>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card" style={{ overflow: "hidden" }}>
            <div className="card-head" style={{ background: "var(--surface-2)" }}>
              <Icon name="viewer" size={16} style={{ color: "var(--ink-3)" }} />
              <div style={{ flex: 1 }}><h3 style={{ fontSize: 13 }}>Preview</h3></div>
              {phase === "done" && (
                <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  {outputs.length > 1 ? `${outputs.length} artifacts` : outputs[0] ? `${outputs[0].fmt} · ${fmtBytes(outputs[0].sizeBytes)}` : `${fmt} · artifact`}
                </span>
              )}
            </div>
            <div style={{ background: "var(--bg-deep)", padding: pdfUrl ? 0 : 24, minHeight: "calc(100vh - 210px)", display: "grid", placeItems: pdfUrl ? "stretch" : "center" }}>
              {phase === "idle" && <div className="empty"><Icon name="tester" size={34} style={{ color: "var(--ink-4)", marginBottom: 10 }} /><div>Configure parameters and run to preview.</div></div>}
              {busy && <RenderingState phase={phase} />}
              {phase === "error" && <div className="empty"><Icon name="alert" size={34} style={{ color: "var(--red)", marginBottom: 10 }} /><div style={{ color: "var(--red)", fontWeight: 600 }}>Render failed</div><div style={{ fontSize: 12.5, marginTop: 4 }}>See the run log below for details.</div></div>}
              {phase === "done" && detail && (
                pdfUrl
                  ? <iframe title="artifact" src={pdfUrl} style={{ width: "100%", height: "calc(100vh - 210px)", border: 0, background: "#525659" }} />
                  : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                      <span className="chip green" style={{ height: 20 }}><i className="led" />rendered {outputs.length > 1 ? `${outputs.length} artifacts` : "artifact"}</span>
                      <div style={{ fontSize: 12, color: "var(--ink-4)" }}>
                        {outputs.length > 0 ? "The file was downloaded automatically — or use the Download button below" : "Artifacts are available from the Output Files page"}
                      </div>
                    </div>
                  )
              )}
            </div>
          </div>

          {outputs.length > 0 && (
            <div className="card">
              <div className="card-head"><Icon name="store" size={16} style={{ color: "var(--green)" }} /><h3 style={{ fontSize: 13 }}>Artifacts ({outputs.length})</h3>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>one file per render unit</span>
                <Link className="btn sm" href="/outputs"><Icon name="viewer" size={13} />Open Output Files</Link>
              </div>
              <div style={{ padding: "4px 0" }}>
                {outputs.map((o) => (
                  <div key={o.objectKey} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: "1px solid var(--line)" }}>
                    <Icon name="doc" size={15} style={{ color: "var(--ink-4)" }} />
                    <span className="mono" style={{ fontSize: 11.5, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.objectKey}</span>
                    <span style={{ fontSize: 11, color: "var(--ink-4)" }}>{fmtBytes(o.sizeBytes)}</span>
                    <span className="tag-pill" style={{ fontSize: 10 }}>{o.fmt}</span>
                    <button className="btn sm" style={{ height: 24 }} onClick={() => download(o)}><Icon name="download" size={12} />Download</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {logs.length > 0 && (
            <div className="card">
              <div className="card-head"><Icon name="history" size={16} style={{ color: "var(--accent)" }} /><h3 style={{ fontSize: 13 }}>Run log</h3>
                <Link className="btn sm ghost" style={{ marginLeft: "auto" }} href="/queue"><Icon name="queue" size={13} />Queue Monitor</Link>
                <span>
                  {phase === "done" && <span className="chip green"><i className="led" />success</span>}
                  {phase === "error" && <span className="chip red"><i className="led" />failed</span>}
                  {busy && <span className="chip blue pulse"><i className="led" />{phase}</span>}
                </span>
              </div>
              <div style={{ padding: 14, fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.9, maxHeight: 180, overflow: "auto", background: "var(--surface-2)" }}>
                {logs.map((l, i) => <div key={i} style={{ display: "flex", gap: 12 }}><span style={{ color: "var(--ink-4)" }}>{l.t}</span><span style={{ color: l.s === "error" ? "var(--red)" : l.s === "ok" ? "var(--green)" : "var(--ink-2)" }}>{l.m}</span></div>)}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

/**
 * Report search-suggest combobox. Lives inside Run configuration (no left column), so typing filters
 * the registered reports and picking one loads it. Keyboard: ↑/↓ to move, Enter to pick, Esc to close.
 */
function ReportPicker({ all, current, onPick }: {
  all: ReportSummary[]; current: ReportDetail | null; onPick: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setQ(""); }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const needle = q.trim().toLowerCase();
  const list = (needle
    ? all.filter((r) => r.name.toLowerCase().includes(needle)
        || r.code.toLowerCase().includes(needle)
        || (r.categoryRef ?? "").toLowerCase().includes(needle))
    : all
  ).slice(0, 50);

  function pick(code: string) { onPick(code); setOpen(false); setQ(""); setHi(0); }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setOpen(false); setQ(""); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, list.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter" && open && list[hi]) { e.preventDefault(); pick(list[hi].code); }
  }

  return (
    <div className="field" ref={boxRef} style={{ position: "relative", margin: 0 }}>
      <label>Report</label>
      <div className="search" style={{ width: "100%" }}>
        <Icon name="search" size={15} />
        <input
          placeholder={current ? current.name : "Search a report by name or code…"}
          value={open ? q : (current?.name ?? "")}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
          onFocus={() => { setOpen(true); setQ(""); }}
          onKeyDown={onKey}
        />
        <Icon name="chevDown" size={14} style={{ color: "var(--ink-4)", flex: "none" }} />
      </div>
      {current && !open && (
        <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 4 }}>{current.code}</div>
      )}
      {open && (
        <div style={{ position: "absolute", zIndex: 40, top: "calc(100% + 4px)", left: 0, right: 0, background: "var(--surface)",
                      border: "1px solid var(--line)", borderRadius: 10, boxShadow: "var(--shadow)", maxHeight: 360, overflow: "auto", padding: 4 }}>
          {list.length === 0 && <div style={{ fontSize: 11.5, color: "var(--ink-4)", padding: 9 }}>No reports match “{q}”</div>}
          {list.map((r, i) => {
            const on = r.code === current?.code;
            const active = i === hi;
            return (
              <div key={r.id} onClick={() => pick(r.code)} onMouseEnter={() => setHi(i)}
                   style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", borderRadius: 8, cursor: "pointer",
                            background: active ? "var(--surface-3)" : on ? "var(--accent-weak)" : "transparent" }}>
                <Icon name="registry" size={13} style={{ color: on ? "var(--accent)" : "var(--ink-4)", flex: "none" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                color: on ? "var(--accent)" : "var(--ink)", fontWeight: on ? 600 : 400 }}>{r.name}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--ink-4)" }}>{r.code}{r.categoryRef ? ` · ${r.categoryRef}` : ""}</div>
                </div>
              </div>
            );
          })}
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

  return (
    <div className="field">
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {def.label || def.name}
        {(def.requiredOverride ?? def.required) && <span style={{ color: "var(--red)" }}>*</span>}
        {def.dependsOn && <span className="chip blue" style={{ height: 17, fontSize: 9.5 }}>← {def.dependsOn}</span>}
        <span style={{ marginLeft: "auto", fontWeight: 400, color: "var(--ink-4)", fontSize: 11 }}>{def.type}</span>
      </label>
      {isSelect ? (
        <Select
          value={value}
          disabled={waitingForParent || loading}
          onChange={onChange}
          placeholder={waitingForParent ? `Select ${def.dependsOn} first` : loading ? "Loading…" : "— select —"}
          options={options.map((o) => ({ value: o.value, label: o.label }))}
        />
      ) : (
        <input
          className="input mono"
          placeholder={def.defaultValue ?? "—"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function RenderingState({ phase }: { phase: Phase }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ width: 80, height: 104, margin: "0 auto 18px", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 6, position: "relative", overflow: "hidden", boxShadow: "var(--shadow)" }}>
        {[18, 30, 42, 54, 66, 78].map((y, i) => (
          <div key={i} style={{ position: "absolute", left: 12, right: 12, top: y, height: 4, borderRadius: 3, background: "var(--surface-3)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: "60%", background: "var(--accent-weak-2)", animation: `shimmer 1.2s ${i * 0.1}s infinite` }} />
          </div>
        ))}
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 13, color: "var(--ink-2)" }}><span className="spin" />{phase === "queued" ? "Queued on Kafka…" : "Engine rendering…"}</div>
      <style>{"@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(180%)}}"}</style>
    </div>
  );
}

