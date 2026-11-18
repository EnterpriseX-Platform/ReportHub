"use client";

import { useEffect, useId, useRef } from "react";
import { ComboBox, Dropdown } from "@carbon/react";

export interface SelectOption { value: string; label: string; sub?: string }

/**
 * Single select over Carbon. Short lists → Carbon `Dropdown`; `searchable`, `onSearch` or more
 * than 8 options → Carbon `ComboBox` (type to filter). Same props as the old hand-made dropdown.
 *
 * - `label`: visible field label (Carbon titleText). Omit when the caller draws its own <label>.
 * - `prefix`: inline label inside the trigger, e.g. "Project:" (Carbon inline dropdown).
 * - `onSearch`: hands the typed text back (debounced 250 ms) so the caller re-fetches from the
 *   server; the list is then shown exactly as passed in (no local filtering).
 * - `note`: helper text under the field (e.g. "showing first 200 — type to search").
 * - `compact`: Carbon size "sm" (32 px) for toolbars; default "md" (40 px).
 * - `helperText`: same as `note` (Carbon name). `readOnly`: Carbon read-only state.
 * - `inline`: Carbon inline dropdown (label sits in the trigger row); `prefix` implies it.
 * - `id`: stable DOM id (e.g. for tests); defaults to a generated one.
 * - `autoAlign`: float the menu (flip/shift) so it is not clipped inside dialogs and scroll panes.
 */
export function Select({ value, onChange, options, placeholder = "Select", disabled, style, searchable, onSearch, note, compact, prefix, label, invalidText, size, helperText, readOnly, inline, id: idProp, className, autoAlign }: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  searchable?: boolean;
  onSearch?: (q: string) => void;
  note?: string;
  compact?: boolean;
  prefix?: string;
  label?: string;
  /** Shows the field in Carbon's invalid state with this message. */
  invalidText?: string;
  size?: "sm" | "md" | "lg";
  helperText?: string;
  readOnly?: boolean;
  inline?: boolean;
  id?: string;
  className?: string;
  autoAlign?: boolean;
}) {
  const genId = useId();
  const id = idProp ?? genId;
  const help = helperText ?? note;
  const current = options.find((o) => o.value === value) ?? null;
  const sz = size ?? (compact ? "sm" : "md");
  const itemToString = (o: SelectOption | null) => (o ? o.label : "");
  const itemToElement = (o: SelectOption) => (
    <span className="rh-opt">
      <span className="rh-opt__label">{o.label}</span>
      {o.sub && <span className="rh-opt__sub">{o.sub}</span>}
    </span>
  );

  // Debounced server search; skip the mount pass (the caller already loaded the first page).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const search = (q: string) => {
    if (!onSearch) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch(q), 250);
  };

  if (searchable || onSearch || options.length > 8) {
    return (
      <div style={style} className={className}>
        <ComboBox<SelectOption>
          id={id}
          titleText={label ?? prefix ?? undefined}
          aria-label={label ?? prefix ?? placeholder}
          placeholder={placeholder}
          items={options}
          itemToString={itemToString}
          itemToElement={itemToElement as never}
          selectedItem={current}
          onChange={({ selectedItem }) => { if (selectedItem) onChange(selectedItem.value); }}
          onInputChange={(q) => search(q ?? "")}
          shouldFilterItem={onSearch ? undefined : ({ item, inputValue }) => {
            const q = (inputValue ?? "").toLowerCase();
            if (!q || q === (current?.label ?? "").toLowerCase()) return true;
            return (item.label + " " + (item.sub ?? "") + " " + item.value).toLowerCase().includes(q);
          }}
          disabled={disabled}
          readOnly={readOnly}
          size={sz}
          helperText={help}
          invalid={!!invalidText}
          invalidText={invalidText}
          autoAlign={autoAlign}
        />
      </div>
    );
  }

  return (
    <div style={style} className={className}>
      <Dropdown<SelectOption>
        id={id}
        type={prefix || inline ? "inline" : "default"}
        titleText={label ?? prefix ?? ""}
        hideLabel={!label && !prefix}
        label={placeholder}
        items={options}
        itemToString={itemToString}
        itemToElement={itemToElement as never}
        renderSelectedItem={(o: SelectOption) => o.label}
        // null (not undefined) keeps downshift controlled when nothing is selected
        selectedItem={current as SelectOption}
        onChange={({ selectedItem }) => { if (selectedItem) onChange(selectedItem.value); }}
        disabled={disabled}
        readOnly={readOnly}
        size={sz}
        helperText={help}
        invalid={!!invalidText}
        invalidText={invalidText}
        autoAlign={autoAlign}
      />
    </div>
  );
}
