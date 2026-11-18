"use client";
import {
  Button, CodeSnippet, IconButton, Tab, TabList, TabPanel, TabPanels, Tabs, TextArea, TextInput,
} from "@carbon/react";
import { Add, Checkmark, Close, Locked, View } from "@carbon/icons-react";

import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./overlays";
import st from "@/components/R/r.module.scss";
import { Select } from "./Select";
import { useToast } from "./Toast";
import { api } from "@/lib/api";
import { usePerms } from "@/lib/perms";
import type {
  AclGrant, AclObjectType, AclPermission, PrincipalType, RowFilterObjectType, RowFilterPreview, RowFilterRuleInput,
} from "@/lib/types";

const PRINCIPALS: { value: PrincipalType; label: string }[] = [
  { value: "role", label: "Role" },
  { value: "responsibility", label: "Responsibility" },
  { value: "user", label: "User" },
];
const PERMS: { value: AclPermission; label: string; sub: string }[] = [
  { value: "view", label: "View", sub: "see it" },
  { value: "run", label: "Run", sub: "view + run / query / export" },
  { value: "edit", label: "Edit", sub: "run + change / delete" },
];
// compact (32px) menu rows have no room for the second line; the full text stays in the label
const PERM_OPTIONS = PERMS.map((p) => ({ value: p.value, label: `${p.label} · ${p.sub}` }));
const OPERATORS = ["=", "<>", "<", "<=", ">", ">=", "IN", "NOT IN", "LIKE", "IS NULL", "IS NOT NULL"];
const ATTRS = ["departmentCode", "positionCode", "employeeCode", "tenant", "username"];
const ROW_FILTER_TYPES: AclObjectType[] = ["REPORT", "DATASET", "REPO_TABLE"];

/**
 * "Access" button for a detail screen. Opens the object's ACL and (for reports, datasets and
 * tables) its row-level filters. Shown only to users allowed to view access rules.
 */
export function AccessButton({ type, id, name, small, ghost }: { type: AclObjectType; id: string | number; name: string; small?: boolean; ghost?: boolean }) {
  const { can } = usePerms();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  if (!can("RH.ACCESS", "view")) return null;
  const close = () => {
    if (dirty) { setAskDiscard(true); return; }
    setDirty(false); setOpen(false);
  };
  return (
    <>
      <Button kind={small || ghost ? "ghost" : "secondary"} size={small ? "sm" : "md"} renderIcon={Locked}
              hasIconOnly={small} iconDescription="Access" tooltipPosition="bottom"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setOpen(true); }}>
        {!small && "Access"}
      </Button>
      {/* Portal: the button often sits in a hover-only row toolbar whose opacity/clicks must not reach the dialog. */}
      {open && createPortal(
        <div onClick={(e) => e.stopPropagation()}>
          <Modal title={`Access · ${name}`} sub={`${type.replace("_", " ").toLowerCase()} ${id}`} width={980} onClose={close}>
            <AccessPanel type={type} id={String(id)} onDirty={setDirty} />
          </Modal>
          {askDiscard && (
            <Modal title="Discard unsaved access changes?" width={400} danger onClose={() => setAskDiscard(false)}
              foot={<>
                <Button kind="secondary" onClick={() => setAskDiscard(false)}>Keep editing</Button>
                <Button kind="danger" onClick={() => { setAskDiscard(false); setDirty(false); setOpen(false); }}>Discard</Button>
              </>}>
              <p className="cds--type-body-01">Changes to grants or row filters that were not saved will be lost.</p>
            </Modal>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Users and roles to pick principals from. Empty lists (e.g. IAM mode without a local user list) mean free text. */
type Directory = { user: string[]; role: string[]; responsibility: string[] };
function useDirectory(): Directory {
  const [d, setD] = useState<Directory>({ user: [], role: [], responsibility: [] });
  useEffect(() => {
    api.users().then((us) => setD({
      user: us.map((u) => u.username).sort(),
      role: Array.from(new Set(["ADMIN", "USER", ...us.map((u) => u.role).filter(Boolean)])).sort(),
      responsibility: [],
    })).catch(() => {});
  }, []);
  return d;
}

function PrincipalCode({ kind, value, disabled, onChange, dir }: {
  kind: PrincipalType | null; value: string; disabled: boolean; onChange: (v: string) => void; dir: Directory;
}) {
  const list = kind ? dir[kind] : [];
  const uid = useId();
  if (!kind || list.length === 0) {
    return <TextInput id={`pc-${uid}`} size="sm" labelText="Code" hideLabel className="rh-mono" disabled={disabled} value={value} placeholder="code" onChange={(e) => onChange(e.target.value)} />;
  }
  const opts = (value && !list.includes(value) ? [value, ...list] : list).map((v) => ({ value: v, label: v }));
  return <Select compact autoAlign searchable disabled={disabled} value={value} placeholder={`Choose ${kind}`} options={opts} onChange={onChange} />;
}

export function AccessPanel({ type, id, onDirty }: { type: AclObjectType; id: string; onDirty?: (d: boolean) => void }) {
  const hasRows = ROW_FILTER_TYPES.includes(type);
  const dir = useDirectory();
  const [d1, setD1] = useState(false);
  const [d2, setD2] = useState(false);
  useEffect(() => { onDirty?.(d1 || d2); }, [d1, d2, onDirty]);
  return (
    <Tabs>
      <TabList aria-label="Access">
        {[<Tab key="acl">Who can use it</Tab>, hasRows && <Tab key="rows">Row filters</Tab>].filter(Boolean)}
      </TabList>
      <TabPanels>
        {/* Panels stay mounted (Carbon hides inactive ones), so unsaved edits survive tab switches */}
        {[
          <TabPanel key="acl"><AclEditor type={type} id={id} dir={dir} onDirty={setD1} /></TabPanel>,
          hasRows && <TabPanel key="rows"><RowFilterEditor type={type as RowFilterObjectType} id={id} dir={dir} onDirty={setD2} /></TabPanel>,
        ].filter(Boolean)}
      </TabPanels>
    </Tabs>
  );
}

function AclEditor({ type, id, dir, onDirty }: { type: AclObjectType; id: string; dir: Directory; onDirty: (d: boolean) => void }) {
  const toast = useToast();
  const { can } = usePerms();
  const editable = can("RH.ACCESS", "update");
  const [rows, setRows] = useState<AclGrant[] | null>(null);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { onDirty(rows !== null && JSON.stringify(rows) !== base); }, [rows, base, onDirty]);

  useEffect(() => {
    api.acl(type, id)
      .then((r) => { const v = r.map(({ principalType, principalCode, permission }) => ({ principalType, principalCode, permission })); setRows(v); setBase(JSON.stringify(v)); })
      .catch((e) => { setRows([]); toast(e instanceof Error ? e.message : "Load failed", "error"); });
  }, [type, id, toast]);

  const set = (i: number, patch: Partial<AclGrant>) => setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valid = (rows ?? []).every((r) => r.principalCode.trim());

  async function save() {
    setBusy(true);
    try {
      await api.saveAcl(type, id, rows!.map((r) => ({ ...r, principalCode: r.principalCode.trim() })));
      setBase(JSON.stringify(rows));
      toast("Access saved", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  if (rows === null) return null;
  return (
    <div>
      <div className="cds--type-body-compact-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-05)" }}>
        {rows.length === 0 ? "Open to everyone with access to the screen." : `Restricted to ${rows.length} grant${rows.length > 1 ? "s" : ""}.`}
      </div>
      {rows.length > 0 && (
        <div className="rh-access-grid rh-access-grid--acl" style={{ marginBottom: 10 }}>
          <span className="rh-access-grid__h cds--type-label-01">Principal</span><span className="rh-access-grid__h cds--type-label-01">Code</span><span className="rh-access-grid__h cds--type-label-01">Permission</span><span />
          {rows.map((r, i) => (
            <AclRow key={i} r={r} dir={dir} editable={editable} onChange={(p) => set(i, p)} onRemove={() => setRows((rs) => rs!.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      {editable && (
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: "var(--cds-spacing-05)" }}>
          <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setRows((rs) => [...rs!, { principalType: "role", principalCode: "", permission: "view" }])}>
            Add grant
          </Button>
          <Button kind="primary" size="md" renderIcon={Checkmark} onClick={save} disabled={busy || !valid}>Save access</Button>
        </div>
      )}
    </div>
  );
}

function AclRow({ r, dir, editable, onChange, onRemove }: {
  r: AclGrant; dir: Directory; editable: boolean; onChange: (p: Partial<AclGrant>) => void; onRemove: () => void;
}) {
  return (
    <>
      <Select compact autoAlign disabled={!editable} value={r.principalType} options={PRINCIPALS}
              onChange={(v) => onChange({ principalType: v as PrincipalType, principalCode: "" })} />
      <PrincipalCode kind={r.principalType} value={r.principalCode} disabled={!editable} dir={dir} onChange={(v) => onChange({ principalCode: v })} />
      <Select compact autoAlign disabled={!editable} value={r.permission} options={PERM_OPTIONS}
              onChange={(v) => onChange({ permission: v as AclPermission })} />
      {editable ? <IconButton kind="ghost" size="sm" label="Remove" align="left" onClick={onRemove}><Close /></IconButton> : <span />}
    </>
  );
}

const blankRule = (): RowFilterRuleInput => ({
  column: "", operator: "=", valueExpr: "${user.departmentCode}", valueType: "text",
  principalType: null, principalCode: null, enabled: true,
});

function RowFilterEditor({ type, id, dir, onDirty }: { type: RowFilterObjectType; id: string; dir: Directory; onDirty: (d: boolean) => void }) {
  const toast = useToast();
  const { can, me } = usePerms();
  const editable = can("RH.ACCESS", "update");
  const [rules, setRules] = useState<RowFilterRuleInput[] | null>(null);
  const [base, setBase] = useState("");
  useEffect(() => { onDirty(rules !== null && JSON.stringify(rules) !== base); }, [rules, base, onDirty]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RowFilterPreview | null>(null);
  const [as, setAs] = useState({ username: "", roles: "", responsibilities: "", attrs: "" });

  useEffect(() => {
    api.rowFilters(type, id)
      .then((rs) => { const v: RowFilterRuleInput[] = rs.map((r) => ({
        column: r.columnName, operator: r.operator, valueExpr: r.valueExpr, valueType: r.valueType,
        principalType: r.principalType, principalCode: r.principalCode, enabled: r.enabled,
      })); setRules(v); setBase(JSON.stringify(v)); })
      .catch((e) => { setRules([]); toast(e instanceof Error ? e.message : "Load failed", "error"); });
  }, [type, id, toast]);

  useEffect(() => {
    if (!me) return;
    setAs({
      username: me.username,
      roles: (me.roles ?? []).join(", "),
      responsibilities: (me.responsibilities ?? []).join(", "),
      attrs: Object.entries(me.attributes ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
    });
  }, [me]);

  const set = (i: number, p: Partial<RowFilterRuleInput>) => setRules((rs) => rs!.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const noValue = (op: string) => op.startsWith("IS ");
  const valid = useMemo(() => (rules ?? []).every((r) =>
    /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(r.column) && (noValue(r.operator) || (r.valueExpr ?? "").trim())
    && (!r.principalType || (r.principalCode ?? "").trim())), [rules]);

  async function save() {
    setBusy(true);
    try {
      await api.saveRowFilters(type, id, rules!.map((r) => ({ ...r, valueExpr: noValue(r.operator) ? null : r.valueExpr })));
      setBase(JSON.stringify(rules));
      toast("Row filters saved", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const attributes: Record<string, string> = {};
    for (const line of as.attrs.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) attributes[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    try {
      setPreview(await api.previewRowFilters(type, id, {
        username: as.username, roles: list(as.roles), responsibilities: list(as.responsibilities), attributes,
      }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Preview failed", "error");
    }
  }

  if (rules === null) return null;
  return (
    <div>
      {rules.length > 0 && (
        <div className="rh-access-grid rh-access-grid--rf" style={{ marginBottom: 10 }}>
          <span className="rh-access-grid__h cds--type-label-01">Column</span><span className="rh-access-grid__h cds--type-label-01">Operator</span><span className="rh-access-grid__h cds--type-label-01">Value</span>
          <span className="rh-access-grid__h cds--type-label-01">Type</span><span className="rh-access-grid__h cds--type-label-01">Applies to</span><span className="rh-access-grid__h cds--type-label-01">Code</span><span />
          {rules.map((r, i) => (
            <RuleRow key={i} r={r} dir={dir} editable={editable} onChange={(p) => set(i, p)}
                     onRemove={() => setRules((rs) => rs!.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      {rules.length === 0 && <div className="cds--type-body-compact-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-05)" }}>No row filters — every permitted user sees all rows.</div>}
      {editable && (
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setRules((rs) => [...rs!, blankRule()])}>Add rule</Button>
            <Select compact autoAlign value="" placeholder="Insert attribute"
                    options={ATTRS.map((a) => ({ value: a, label: `\${user.${a}}` }))}
                    onChange={(a) => setRules((rs) => rs && rs.length
                      ? rs.map((r, j) => (j === rs.length - 1 ? { ...r, valueExpr: `\${user.${a}}` } : r))
                      : [{ ...blankRule(), valueExpr: `\${user.${a}}` }])}
                    style={{ minWidth: 200 }} />
          </div>
          <Button kind="primary" size="md" renderIcon={Checkmark} onClick={save} disabled={busy || !valid}>Save row filters</Button>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--cds-border-subtle-01)", marginTop: "var(--cds-spacing-06)", paddingTop: "var(--cds-spacing-05)" }}>
        <h4 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-05)" }}>Preview as user</h4>
        <div className="rh-form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <TextInput id="rf-as-user" labelText="Username" className="rh-mono" value={as.username} onChange={(e) => setAs({ ...as, username: e.target.value })} />
          <TextInput id="rf-as-roles" labelText="Roles" className="rh-mono" value={as.roles} onChange={(e) => setAs({ ...as, roles: e.target.value })} />
          <TextInput id="rf-as-resp" labelText="Responsibilities" className="rh-mono" value={as.responsibilities} onChange={(e) => setAs({ ...as, responsibilities: e.target.value })} />
        </div>
        <div style={{ marginTop: "var(--cds-spacing-05)" }}>
          <TextArea id="rf-as-attrs" labelText="Attributes (name=value per line)" className="rh-mono" rows={3} value={as.attrs}
                    onChange={(e) => setAs({ ...as, attrs: e.target.value })} placeholder={"departmentCode=D01\npositionCode=P7"} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--cds-spacing-03)" }}>
          <Button kind="secondary" size="md" renderIcon={View} onClick={runPreview}>Preview saved rules</Button>
        </div>
        {preview && (
          <div style={{ marginTop: 10 }}>
            <div className="cds--type-body-compact-01" style={{ marginBottom: "var(--cds-spacing-03)", color: preview.denied ? "var(--cds-text-error)" : "var(--cds-text-primary)" }}>
              {!preview.filtered ? "No filter applies to this user." : preview.denied ? "This user sees no rows (a referenced attribute is missing)." : `Filtered · binds: ${preview.binds.join(" | ")}`}
            </div>
            {preview.effectiveSql || (preview.sql && !preview.sql.includes("<source query>"))
              ? <CodeSnippet type="multi" feedback="Copied">{preview.effectiveSql ?? preview.sql ?? ""}</CodeSnippet>
              : preview.condition && <CodeSnippet type="multi" feedback="Copied">{`WHERE ${preview.condition}`}</CodeSnippet>}
            {(preview.params ?? preview.binds)?.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div className="cds--type-label-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-02)" }}>Params</div>
                <CodeSnippet type="multi" feedback="Copied">{(preview.params ?? preview.binds).map((v, i) => `:${i + 1} = ${v}`).join("\n")}</CodeSnippet>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RuleRow({ r, dir, editable, onChange, onRemove }: {
  r: RowFilterRuleInput; dir: Directory; editable: boolean; onChange: (p: Partial<RowFilterRuleInput>) => void; onRemove: () => void;
}) {
  const nullOp = r.operator.startsWith("IS ");
  const uid = useId();
  return (
    <>
      <TextInput id={`rf-col-${uid}`} size="sm" labelText="Column" hideLabel className="rh-mono" disabled={!editable} value={r.column} placeholder="COLUMN" onChange={(e) => onChange({ column: e.target.value })} />
      <Select compact autoAlign disabled={!editable} value={r.operator} options={OPERATORS.map((o) => ({ value: o, label: o }))}
              onChange={(v) => onChange({ operator: v })} />
      <TextInput id={`rf-val-${uid}`} size="sm" labelText="Value" hideLabel className="rh-mono" disabled={!editable || nullOp} value={nullOp ? "" : r.valueExpr ?? ""}
             placeholder={r.operator.includes("IN") ? "A,B or ${user.x}" : "${user.departmentCode}"}
             onChange={(e) => onChange({ valueExpr: e.target.value })} />
      <Select compact autoAlign disabled={!editable || nullOp} value={r.valueType}
              options={[{ value: "text", label: "Text" }, { value: "number", label: "Number" }]}
              onChange={(v) => onChange({ valueType: v as "text" | "number" })} />
      <Select compact autoAlign disabled={!editable} value={r.principalType ?? ""}
              options={[{ value: "", label: "Everyone" }, ...PRINCIPALS]}
              onChange={(v) => onChange({ principalType: (v || null) as PrincipalType | null, principalCode: v ? "" : null })} />
      <PrincipalCode kind={r.principalType} value={r.principalCode ?? ""} disabled={!editable || !r.principalType} dir={dir}
                     onChange={(v) => onChange({ principalCode: v })} />
      {editable ? <IconButton kind="ghost" size="sm" label="Remove" align="left" onClick={onRemove}><Close /></IconButton> : <span />}
    </>
  );
}
