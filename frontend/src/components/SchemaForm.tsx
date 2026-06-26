"use client";

import { Select } from "@/components/Select";
import type { EngineProp } from "@/lib/types";

/**
 * Renders an engine-declared list of {@link EngineProp} as a form. One component drives every
 * config surface (Engines install modal, register wizard, per-unit config) so picking an engine
 * determines exactly how it is configured. Values are a flat string map keyed by prop.key.
 */
export function SchemaForm({ props, values, onChange, empty }: {
  props: EngineProp[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  empty?: string;
}) {
  if (!props || props.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--ink-4)" }}>{empty ?? "This engine has no configurable properties."}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {props.map((p) => {
        const v = values[p.key] ?? "";
        return (
          <div className="field" key={p.key}>
            <label>{p.label}{p.required && <span style={{ color: "var(--red)" }}> *</span>}</label>
            {p.type === "select" ? (
              <Select value={v || (p.options?.[0] ?? "")} onChange={(x) => onChange(p.key, x)}
                      options={(p.options ?? []).map((o) => ({ value: o, label: o }))} />
            ) : p.type === "bool" ? (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-2)" }}>
                <input type="checkbox" checked={v === "true"} onChange={(e) => onChange(p.key, e.target.checked ? "true" : "false")} />
                {p.placeholder || "enabled"}
              </label>
            ) : p.type === "textarea" || p.type === "sql" ? (
              <textarea className={"input" + (p.type === "sql" ? " mono" : "")} rows={p.type === "sql" ? 5 : 3}
                        placeholder={p.placeholder ?? ""} value={v} onChange={(e) => onChange(p.key, e.target.value)} />
            ) : (
              <input className={"input" + (p.type === "url" || p.type === "password" ? " mono" : "")}
                     type={p.type === "password" ? "password" : p.type === "number" ? "number" : "text"}
                     placeholder={p.placeholder ?? ""} value={v} onChange={(e) => onChange(p.key, e.target.value)} />
            )}
            {p.help && <span className="hint">{p.help}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** configJson string -> flat values map (for UNIT_CONFIG_JSON props). Tolerates blank/invalid JSON. */
export function configToValues(configJson: string | null | undefined): Record<string, string> {
  if (!configJson || !configJson.trim()) return {};
  try {
    const obj = JSON.parse(configJson);
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(obj)) out[k] = val == null ? "" : String(val);
    return out;
  } catch {
    return {};
  }
}

/**
 * flat values map -> configJson string. Declared props (in `keys`) are dropped when blank; any
 * OTHER keys already present in `values` (pre-existing configJson keys the current engine doesn't
 * declare — e.g. a legacy/extra option, or a key from a different engine) are preserved verbatim so
 * editing one field never silently drops the rest of an existing config. Returns null when empty.
 */
export function valuesToConfig(values: Record<string, string>, keys: string[]): string | null {
  const declared = new Set(keys);
  const obj: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (declared.has(k)) {
      if (v != null && v !== "") obj[k] = v;
    } else if (v != null) {
      obj[k] = v; // undeclared pre-existing key — keep it, don't clobber the user's config
    }
  }
  return Object.keys(obj).length ? JSON.stringify(obj) : null;
}
