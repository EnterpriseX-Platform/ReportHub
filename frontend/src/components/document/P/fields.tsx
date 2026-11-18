"use client";
// Compact Carbon field helpers for the document editor chrome. Group P.
import { useId, type ChangeEvent, type CSSProperties, type InputHTMLAttributes } from "react";
import { Checkbox, TextInput } from "@carbon/react";
import css from "./fields.module.scss";

type FProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "style"> & {
  label?: string; mono?: boolean; style?: CSSProperties;
};

/** Small Carbon TextInput; `style` width/flex apply to the field wrapper. */
export function F({ label, mono, style, placeholder, ...rest }: FProps) {
  const id = useId();
  const { width, flex, minWidth, maxWidth, fontWeight } = style ?? {};
  const ariaLabel = (rest as { "aria-label"?: string })["aria-label"];
  return (
    <div className={css.field} style={{ width, flex, minWidth: minWidth ?? (flex ? 160 : undefined), maxWidth }}>
      <TextInput id={id} size="sm" labelText={label ?? ariaLabel ?? placeholder ?? ""} hideLabel={!label} placeholder={placeholder}
                 className={mono ? css.mono : undefined} style={fontWeight ? { fontWeight } : undefined}
                 {...(rest as object)} />
    </div>
  );
}

/** Carbon Checkbox with the legacy `(e) => e.target.checked` handler shape. */
export function Chk({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (e: { target: { checked: boolean } }) => void;
}) {
  const id = useId();
  return <Checkbox id={id} labelText={label} checked={checked} onChange={(_: ChangeEvent<HTMLInputElement>, { checked: c }: { checked: boolean }) => onChange({ target: { checked: c } })} />;
}
