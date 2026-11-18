"use client";

import { Checkbox, PasswordInput, Stack, TextArea, TextInput } from "@carbon/react";
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
    return <p className="cds--type-helper-text-01 rh-dim">{empty ?? "This engine has no configurable properties."}</p>;
  }
  return (
    <Stack gap={5}>
      {props.map((p) => {
        const v = values[p.key] ?? "";
        const id = `sf-${p.key}`;
        const label = <>{p.label}{p.required && <span style={{ color: "var(--cds-text-error)" }}> *</span>}</>;
        const mono = p.type === "url" || p.type === "password" || p.type === "sql" ? "rh-mono" : undefined;
        if (p.type === "select") {
          return (
            <Select key={p.key} label={p.label + (p.required ? " *" : "")} value={v || (p.options?.[0] ?? "")} onChange={(x) => onChange(p.key, x)}
                    options={(p.options ?? []).map((o) => ({ value: o, label: o }))} note={p.help ?? undefined} />
          );
        }
        if (p.type === "bool") {
          return (
            <Checkbox key={p.key} id={id} labelText={p.placeholder || "enabled"} helperText={p.help ?? undefined}
                      checked={v === "true"} onChange={(_, { checked }) => onChange(p.key, checked ? "true" : "false")}
                      title={p.label} />
          );
        }
        if (p.type === "textarea" || p.type === "sql") {
          return (
            <TextArea key={p.key} id={id} labelText={label} className={mono || undefined} rows={p.type === "sql" ? 5 : 3}
                      placeholder={p.placeholder ?? ""} value={v} helperText={p.help ?? undefined} onChange={(e) => onChange(p.key, e.target.value)} />
          );
        }
        if (p.type === "password") {
          return (
            <PasswordInput key={p.key} id={id} labelText={label} className={mono} placeholder={p.placeholder ?? ""} value={v}
                           helperText={p.help ?? undefined} onChange={(e) => onChange(p.key, e.target.value)} />
          );
        }
        return (
          <TextInput key={p.key} id={id} labelText={label} className={mono} type={p.type === "number" ? "number" : "text"}
                     placeholder={p.placeholder ?? ""} value={v} helperText={p.help ?? undefined} onChange={(e) => onChange(p.key, e.target.value)} />
        );
      })}
    </Stack>
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
