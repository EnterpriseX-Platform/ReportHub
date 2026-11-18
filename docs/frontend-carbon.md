# Frontend: IBM Carbon

The frontend uses the real IBM Carbon library — `@carbon/react`, `@carbon/styles`, `@carbon/icons-react` —
not hand-written look-alikes. This is the brief for migrating a screen.

## Setup (already done)

- `src/app/carbon.scss` — loads `@carbon/react` (White theme on `:root`, G100 for `<html data-theme="dark">`
  and for the UI-shell header), points Carbon's font stacks at the IBM Plex fonts loaded by `next/font`
  (no second font download), and holds the small `rh-*` app layer (layout glue Carbon does not ship).
- `src/app/globals.css` — base rules only (box-sizing, body font, scrollbars), the pipeline flow-diagram canvas
  and the paginated document pages (screen + print). The old look-alike classes are gone.
- Style with Carbon tokens (`var(--cds-text-secondary)`, `theme.$layer-01` in SCSS), spacing tokens
  (`$spacing-05` = 16px) and type classes (`cds--type-heading-03`, `cds--type-body-compact-01`,
  `cds--type-code-01`, `cds--type-label-01`). The legacy `--ink/--surface/--accent` tokens were removed.

## Which Carbon component for which pattern

| Pattern in this app | Use |
|---|---|
| Page title + actions | `PageHeader` (ui.tsx). The shell already renders the `Breadcrumb`. |
| Buttons | `Button` (`kind` primary/secondary/tertiary/ghost/danger/danger--ghost, `renderIcon={Add}`), `IconButton` for icon-only (has a tooltip `label`). Links that look like buttons: `<Button as={Link} href=…>`. Footer pairs: `ButtonSet`. |
| Text / number / password fields | `TextInput`, `NumberInput`, `PasswordInput`, `TextArea`; errors via `invalid` + `invalidText` |
| Single select | `Select` wrapper (components/Select.tsx) → Carbon `Dropdown` / `ComboBox` |
| Multi select | `FilterableMultiSelect` / `MultiSelect` |
| Checkbox / toggle / radio | `Checkbox`, `Toggle`, `RadioButtonGroup` |
| Date | `DatePicker` + `DatePickerInput` |
| File upload | `FileUploaderDropContainer` (+ `FileUploaderItem`) |
| Lists of records | `DataList` helper (components/DataList.tsx) over Carbon DataTable parts |
| Key/value or short lists in panels | `StructuredListWrapper` (`isCondensed`) |
| Status / format / engine labels | `StatusChip`, `FmtTag`, `EngineBadge` (ui.tsx) → Carbon `Tag`; other labels: `Tag` |
| Cards / summary numbers | `Tile` (`ClickableTile` when the whole card navigates); `MetricCard` (ui.tsx) |
| Tabs / segmented toggles | `Tabs` + `TabList` + `Tab` + `TabPanels`; `ContentSwitcher` for view toggles |
| Confirm / create dialogs | `Modal` wrapper (overlays.tsx) → `ComposedModal`; destructive: `danger` |
| Detail / edit panel | `SlideOver` wrapper (overlays.tsx) — Carbon side-panel pattern |
| Row menus | `OverflowMenu` + `OverflowMenuItem` (`isDelete` for delete) |
| Feedback after an action | `useToast()` (Toast.tsx) → `ToastNotification` |
| Error / warning inside a page or form | `InlineNotification` (`lowContrast`, `hideCloseButton`) |
| Loading | `Skeleton` / `TableSkeleton` (ui.tsx), `SkeletonText`, `DataTableSkeleton`, `SkeletonPlaceholder` |
| Code / SQL text | `CodeSnippet` (`type="single"|"multi"`) |
| Pagination | `Pagination` (built into `DataList`) |
| Icons | `@carbon/icons-react` directly (`import { Add } from "@carbon/icons-react"`) or legacy `<Icon name="…">` (now mapped to Carbon icons; `carbonIcon(name)` returns the component for `renderIcon`) |

## Wrapper APIs (unchanged props, Carbon underneath)

- **`Select`** `{ value, onChange(v), options: {value,label,sub?}[], placeholder?, disabled?, style?, searchable?,
  onSearch?(q), note?, compact?, prefix?, label?, invalidText?, size? }` — ≤8 options → `Dropdown`; `searchable`,
  `onSearch` (debounced 250 ms, server filtering) or >8 options → `ComboBox`. `label` = visible field label
  (prefer it over a separate `<label>`); `prefix` = inline dropdown label; `note` = helper text; `compact` = size sm.
- **`Modal`** `{ title, sub?, onClose, foot?, width?, danger? }` — always open (render conditionally). `width` maps to
  xs/sm/md/lg. `foot` = Carbon `Button`s (secondary first, primary last); they fill the footer.
- **`SlideOver`** `{ title, sub?, badge?, onClose, foot?, width? }` — right panel under the header; Escape/overlay closes.
  Put footer buttons in `<ButtonSet className="rh-foot-set">`.
- **`useToast()`** → `toast(msg, "ok" | "error" | "warning" | "default")`.
- **`Skeleton({rows})`**, **`TableSkeleton({rows, columns, toolbar})`**, **`FieldError({errors, name})`** (prefer `invalidText`).
- **`StatusChip({s, size})`**, **`FmtTag({f})`**, **`Fmts({list})`**, **`EngineBadge({engine, sm})`**, **`MetricCard`**, **`MiniStat`**, **`PageHeader`**.
- **`DataList<T extends {id}>`** `{ rows, columns: {key, header, render?, sortValue?, sortable?, align?: "end", width?}[],
  title?, description?, search? (toolbar search, default on), searchText?(row), toolbar? (e.g. primary Button),
  batchActions?: {label, icon?, onClick(selected)}[] (turns on row checkboxes), onRowClick?(row), rowActions?(row),
  empty?, loading?, pageSize? (25), pagination? (client-side; false for server paging), size?, initialSort? }`.
  Reference: `components/integrations/DatabasesPanel.tsx`, `app/page.tsx`.

## Rules

1. **No native `<select>` and no native file input.** Use `Select`/`Dropdown`/`ComboBox`/`FilterableMultiSelect`
   and `FileUploaderDropContainer`.
2. **No spinners or "Loading…" text.** Use Carbon skeletons (`Skeleton`, `TableSkeleton`, `DataTableSkeleton`).
   `InlineLoading` only for a button's own in-flight state, if at all.
3. **No helper paragraphs / step-by-step instructions on screens.** Headings and field labels only;
   short `helperText` on a field when a format is genuinely required.
4. No new hand-written CSS that imitates a Carbon component. App CSS is for layout only, uses Carbon tokens,
   and goes in `carbon.scss` (`rh-` prefix) or a screen-level SCSS module.
5. No `window.confirm`/`alert` — confirm with `Modal danger` or an in-place two-step button.
6. Keep IAM checks (`usePerms().can(obj, action)`) exactly as they are when migrating.
7. Migrating a screen: replace legacy classes with Carbon components, check it at 1440 / 1056 / 672 / 390 px,
   run `npx tsc --noEmit`.
8. Shared layout classes (carbon.scss): `rh-ops` (+ `rh-ops--rail-off`, `rh-ops--stack`, `rh-ops--detail`) with
   `rh-ops__nav` / `rh-ops__nav--collapsed` / `rh-ops__list` for list rail + work area; `rh-fill` on the work area makes
   the shell content one viewport tall (lg and up) so the page never scrolls — panes scroll; `rh-nt-*` for the
   drag-and-drop folder trees; `rh-mono` (inputs and textareas); `rh-switch-fit` (content-sized ContentSwitcher);
   `rh-docx-*`, `rh-dash-grid`, `rh-queue-layout`, `rh-access-grid`. `DataList` rows may use string or numeric ids.

## Already migrated

App shell (`AppShell.tsx`: Header, HeaderMenuButton, HeaderName, project `HeaderMenu`, `HeaderGlobalAction`s with
`HeaderPanel`s for search / notifications / user, `SideNav` with `SideNavMenu` groups + rail/overlay, `Breadcrumb`,
`Content`) and every screen under `src/app`.
