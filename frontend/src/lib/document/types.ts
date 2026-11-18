// Document model for the built-in Documents capability.
// A document is a list of sections; each section is a list of blocks laid out on pages.

export type Orientation = "portrait" | "landscape";
export type Align = "left" | "center" | "right" | "justify";

/** Page size: a preset id (see pageSizes.ts) or a custom size in millimetres. */
export type PageSizeValue = string | { widthMm: number; heightMm: number };

export interface Margins { top: number; right: number; bottom: number; left: number }

export interface PageSetup {
  size: PageSizeValue;
  orientation: Orientation;
  marginsMm: Margins;
  /** Running header / footer text; {{page}} and {{pages}} expand to page numbers, {{param}} to parameter values. */
  header?: string;
  footer?: string;
  fontFamily?: string;
  fontSizePt?: number;
}

export interface DocParam {
  name: string;
  label?: string;
  defaultValue?: string;
}

export interface GridCell {
  text: string;
  /** Spreadsheet-style formula without the leading "=" is not allowed: store "=SUM(B2:B4)". */
  formula?: string;
  colSpan?: number;
  rowSpan?: number;
  /** Hidden under a merged neighbour. */
  covered?: boolean;
  /** Text to show when a vertically merged cell continues on the next page. */
  contText?: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  /** Placeholder block while bound data is loading (screen only). */
  skeleton?: boolean;
  bg?: string;
  color?: string;
  /** Border widths in points per side; 0 = no line. Undefined = table default. */
  borders?: { t?: number; r?: number; b?: number; l?: number };
}

export interface TableSource {
  /** ReportHub dataset id; its SQL may use $P{name} placeholders. */
  datasetId: number;
  /** Values for the dataset placeholders; may reference document parameters as {{name}}. */
  params: Record<string, string>;
  /** Dataset columns to show, in order. Empty = all columns. */
  columns?: string[];
  /** Append a row with the sum of every numeric column. */
  totalRow?: boolean;
  totalLabel?: string;
  /** Columns summed on the total row (user's choice, kept as-is). Undefined = numeric, non-ID columns. */
  totalColumns?: string[];
}

interface BlockBase {
  id: string;
  /** Force this block onto pages of its own orientation (e.g. a wide table on landscape pages). */
  landscape?: boolean;
  /** Start this block on a new page. */
  pageBreakBefore?: boolean;
}

export interface HeadingBlock extends BlockBase {
  type: "heading";
  level: 1 | 2 | 3;
  text: string;
  align?: Align;
  /** Exclude from the table of contents. */
  noToc?: boolean;
}

export interface ParagraphBlock extends BlockBase {
  type: "paragraph";
  /** Plain text with **bold**, *italic*, __underline__ and {{param}} placeholders; blank lines = new paragraph. */
  text: string;
  align?: Align;
  sizePt?: number;
  indentMm?: number;
}

export interface TableBlock extends BlockBase {
  type: "table";
  title?: string;
  grid: GridCell[][];
  /** Rows at the top repeated on every page the table spans. */
  headerRows: number;
  /** Relative column widths (any unit); empty = equal. */
  colWidths?: number[];
  fontSizePt?: number;
  /** Decimal places for numeric values. Undefined = 0 for whole-number columns, 2 otherwise. */
  decimals?: number;
  /** Bound data: header rows of `grid` are kept, body rows come from the dataset. */
  source?: TableSource;
  /** Keep the table on one page (moves it to the next page instead of splitting). */
  keepWhole?: boolean;
}

export interface ImageBlock extends BlockBase {
  type: "image";
  url: string;
  caption?: string;
  widthPct: number;
  align?: "left" | "center" | "right";
}

export interface TocBlock extends BlockBase {
  type: "toc";
  title: string;
  maxLevel: 1 | 2 | 3;
}

export interface DividerBlock extends BlockBase { type: "divider" }
export interface PageBreakBlock extends BlockBase { type: "pageBreak" }
export interface SpacerBlock extends BlockBase { type: "spacer"; heightMm: number }

export type Block =
  | HeadingBlock | ParagraphBlock | TableBlock | ImageBlock | TocBlock
  | DividerBlock | PageBreakBlock | SpacerBlock;
export type BlockType = Block["type"];

export interface Section {
  id: string;
  title: string;
  orientation?: Orientation;
  /** Start this section on a new page (default true). */
  newPage?: boolean;
  /** Leave the section out of preview and export. */
  disabled?: boolean;
  blocks: Block[];
}

export interface DocContent {
  version: 1;
  page: PageSetup;
  params: DocParam[];
  sections: Section[];
}

// --- API payloads ------------------------------------------------------------

export interface DocSummary {
  id: number;
  title: string;
  description: string | null;
  folder: string | null;
  revision: number;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  filehubFileId?: string | null;
  filehubUrl?: string | null;
  filehubPublishedAt?: string | null;
}

export interface DocRecord {
  id: number;
  title: string;
  description: string | null;
  folder: string | null;
  revision: number;
  content: DocContent;
  updatedBy: string | null;
  updatedAt: string;
}

export interface BlockData {
  columns: string[];
  rows: (string | number | null)[][];
  error: string | null;
}

export interface DocAsset {
  id: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export interface PrintPayload {
  document: DocRecord;
  params: Record<string, string>;
  data: Record<string, BlockData>;
}
