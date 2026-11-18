"use client";

/**
 * The SQL box used everywhere SQL is typed in Report Studio — datasets, data checks, warehouse
 * pipelines, scheduled SQL and the repository SQL editor.
 *
 * Modelled on the Integration Platform's SQL editor, with the same parts and behaviour — CodeMirror with line numbers,
 * folding, bracket matching, autocomplete, a Format button and a place to click template variables
 * in — rather than the bare <textarea> that was here before.
 *
 * Two differences from Integration's, both deliberate:
 *  - it sits inline in the form instead of only in a modal (the forms here are one-column and the
 *    SQL is the main field), with a full-screen toggle for the long ones;
 *  - colours come from the app's CSS variables, so it follows the light/dark skin like every other
 *    control. Integration's is hard-coded light.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { EditorView, Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { Button, IconButton, Tag } from "@carbon/react";
import { Checkmark, Code, Maximize, Minimize } from "@carbon/icons-react";
import styles from "./D/SqlEditor.module.scss";
import { Modal } from "./overlays";
import { formatSql } from "../lib/sqlFormat";

// CodeMirror reaches for `document` as it mounts, so it must not be part of the server render.
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => <div className="cds--skeleton" style={{ height: 120 }} />,
});

/**
 * `$YEAR4` / `$YEAR2` (and Oracle `:binds`) are substituted before the statement runs, so they are
 * not SQL and the highlighter would paint them as plain identifiers. Marking them keeps a
 * placeholder visible — the usual mistake is a year hard-coded where a placeholder was meant.
 */
const placeholderMark = Decoration.mark({ class: "cm-tpl-var" });
const placeholderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.find(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = this.find(u.view); }
    find(view: EditorView): DecorationSet {
      const out = [];
      const re = /\$[A-Z_][A-Z0-9_]*|\{\{[^}]+\}\}|(?<![:\w]):[a-zA-Z][\w$]*/g;
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          out.push(placeholderMark.range(from + m.index, from + m.index + m[0].length));
        }
      }
      return Decoration.set(out);
    }
  },
  { decorations: (v) => v.decorations },
);

// Syntax colours and chrome come from Carbon tokens, so the editor follows the White / G100 theme.
const MONO = "var(--cds-code-02-font-family, 'IBM Plex Mono', monospace)";
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--cds-tag-color-blue)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--cds-tag-color-green)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cds-tag-color-purple)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--cds-text-helper)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.standard(t.variableName)], color: "var(--cds-tag-color-teal)" },
  { tag: t.operator, color: "var(--cds-text-secondary)" },
  { tag: t.typeName, color: "var(--cds-tag-color-teal)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "0.875rem", background: "var(--cds-field-01)", color: "var(--cds-text-primary)" },
  "&.cm-focused": { outline: "2px solid var(--cds-focus)", outlineOffset: "-2px" },
  ".cm-content": { fontFamily: MONO, lineHeight: "1.43", padding: "var(--cds-spacing-03) 0", caretColor: "var(--cds-text-primary)" },
  ".cm-gutters": { background: "var(--cds-layer-01)", color: "var(--cds-text-helper)", border: "none",
                   borderRight: "1px solid var(--cds-border-subtle-01)", fontFamily: MONO, fontSize: "0.75rem" },
  ".cm-activeLine": { background: "var(--cds-layer-hover-01)" },
  ".cm-activeLineGutter": { background: "var(--cds-layer-selected-01)", color: "var(--cds-text-primary)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { background: "var(--cds-highlight)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cds-text-primary)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    background: "var(--cds-highlight)", outline: "1px solid var(--cds-interactive)", color: "inherit" },
  ".cm-tooltip": { background: "var(--cds-layer-01)", border: "1px solid var(--cds-border-subtle-01)", borderRadius: 0,
                   boxShadow: "0 2px 6px rgba(0,0,0,.3)", color: "var(--cds-text-primary)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--cds-layer-selected-01)", color: "var(--cds-text-primary)" },
  ".cm-tpl-var": { background: "var(--cds-tag-background-warm-gray)", color: "var(--cds-tag-color-warm-gray)",
                   borderRadius: 0, padding: "0 2px", fontWeight: "600" },
  ".cm-placeholder": { color: "var(--cds-text-placeholder)" },
});

const EXTENSIONS: Extension[] = [sql(), syntaxHighlighting(highlight), placeholderPlugin, theme];

export type SqlEditorProps = {
  value: string;
  onChange: (value: string) => void;
  /** Editor height in px when inline. Full screen ignores it. */
  height?: number;
  placeholder?: string;
  /** Clickable tokens shown above the editor, inserted at the cursor — e.g. `["$YEAR4", "$YEAR2"]`. */
  vars?: string[];
  readOnly?: boolean;
  /** Extra note shown on the right of the toolbar. */
  hint?: string;
};

export function SqlEditor({ value, onChange, height = 160, placeholder, vars, readOnly, hint }: SqlEditorProps) {
  const [full, setFull] = useState(false);
  const editor = <Body {...{ value, onChange, placeholder, vars, readOnly, hint }}
                       height={full ? undefined : height} full={full} onToggleFull={() => setFull(!full)} />;
  if (!full) return editor;
  return (
    <>
      {/* Left in place so the form does not jump when the big editor closes. */}
      <div className={`cds--type-helper-text-01 ${styles.placeholder}`} style={{ height }}>
        Editing in full screen
      </div>
      <Modal title="SQL Editor" onClose={() => setFull(false)} width={1180}
             foot={<Button kind="primary" renderIcon={Checkmark} onClick={() => setFull(false)}>Done</Button>}>
        {editor}
      </Modal>
    </>
  );
}

function Body({ value, onChange, height, placeholder, vars, readOnly, hint, full, onToggleFull }:
              SqlEditorProps & { full: boolean; onToggleFull: () => void }) {
  const view = useRef<EditorView | null>(null);
  const [lines, setLines] = useState(1);
  useEffect(() => setLines(value ? value.split("\n").length : 1), [value]);

  /** Insert at the cursor, not at the end: half the time the placeholder belongs mid-WHERE. */
  const insert = useCallback((token: string) => {
    const v = view.current;
    if (!v) { onChange(value + token); return; }
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: token }, selection: { anchor: from + token.length } });
    v.focus();
  }, [onChange, value]);

  /**
   * `height` is the height of the whole box (toolbar + editor), not just the editor.
   *
   * <p>Passing height straight to CodeMirror made the box taller than requested by the toolbar
   * height (~42px), so a container clipped to `height` (e.g. `.sqled` on the Ad-hoc screen) hid the
   * last lines. CodeMirror's scroller itself was fine — the tail was simply outside the clip.
   * <p>Now split with flex: the toolbar takes what it needs (it may wrap with many variable chips)
   * and the editor gets the rest, so the total equals `height` exactly regardless of toolbar size.
   * Without height (e.g. fullscreen) the box grows with its content.
   */
  const fixed = typeof height === "number";
  return (
    <div className={styles.box} style={fixed ? { height, display: "flex", flexDirection: "column" } : undefined}>
      <div className={styles.bar}>
        <Button kind="ghost" size="sm" renderIcon={Code} title="Format SQL for readability"
                disabled={readOnly} onClick={() => onChange(formatSql(value))}>
          Format
        </Button>
        {vars && vars.length > 0 && (
          <>
            <span className="cds--type-label-01 rh-dim">Insert variable</span>
            {vars.map((v) => (
              <Tag key={v} type="warm-gray" size="sm" as="button" disabled={readOnly} onClick={() => insert(v)}
                   title={`Insert ${v} at the cursor`} className={styles.var}>{v}</Tag>
            ))}
          </>
        )}
        <span className={styles.right}>
          {hint && <span className="cds--type-helper-text-01 rh-dim">{hint}</span>}
          <span className="cds--type-code-01 rh-dim">{lines} line{lines === 1 ? "" : "s"}</span>
          <IconButton kind="ghost" size="sm" align="bottom-end" onClick={onToggleFull}
                      label={full ? "Exit full screen" : "Full screen"}>
            {full ? <Minimize /> : <Maximize />}
          </IconButton>
        </span>
      </div>
      {/* Needs minHeight: 0 (in .sqlbox-fill) — a flex item defaults to min-height:auto and would
          refuse to shrink, pushing the box past `height` again.
          The height must also reach the wrapper <div> react-codemirror puts around CodeMirror
          (`.cm-theme-light/dark`); otherwise .cm-editor's height:100% resolves against an auto
          parent, the editor grows with content, has no scrollbar, and the overflow is clipped. */}
      <div className={fixed ? "sqlbox-fill" : undefined}>
      <CodeMirror
        value={value}
        height={fixed ? "100%" : "62vh"}
        editable={!readOnly}
        extensions={EXTENSIONS}
        onChange={onChange}
        onCreateEditor={(v: EditorView) => { view.current = v; }}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightActiveLine: true,
          foldGutter: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
        }}
      />
      </div>
    </div>
  );
}
