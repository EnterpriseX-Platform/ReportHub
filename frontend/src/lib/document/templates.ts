// Starter templates offered when creating a document.
import type { Block, DocContent, GridCell, Section } from "./types";
import { DEFAULT_PAGE_SIZE } from "./pageSizes";
import { uid } from "./text";

const h = (text: string, b: Partial<GridCell> = {}): GridCell => ({ text, bold: true, align: "center", bg: "#e8eef7", ...b });
const t = (text: string, b: Partial<GridCell> = {}): GridCell => ({ text, ...b });
const n = (text: string): GridCell => ({ text, align: "right" });
const f = (formula: string, bold = false): GridCell => ({ text: "", formula, align: "right", bold });

function section(title: string, blocks: Block[], extra: Partial<Section> = {}): Section {
  return { id: uid("s"), title, newPage: true, blocks, ...extra };
}

export function blankContent(): DocContent {
  return {
    version: 1,
    page: { size: DEFAULT_PAGE_SIZE, orientation: "portrait", marginsMm: { top: 20, right: 18, bottom: 20, left: 18 }, footer: "Page {{page}} of {{pages}}", fontSizePt: 11 },
    params: [],
    sections: [section("Section 1", [
      { id: uid(), type: "heading", level: 1, text: "Untitled document" },
      { id: uid(), type: "paragraph", text: "Start writing here." },
    ])],
  };
}

function quarterlySales(): DocContent {
  const regions = ["North", "South", "East", "West", "Central"];
  const grid: GridCell[][] = [
    [h("Region", { rowSpan: 2 }), h("Monthly revenue (USD)", { colSpan: 3 }), t("", { covered: true }), t("", { covered: true }), h("Quarter total", { rowSpan: 2 }), h("Target", { rowSpan: 2 }), h("Attainment %", { rowSpan: 2 })],
    [t("", { covered: true }), h("Month 1"), h("Month 2"), h("Month 3"), t("", { covered: true }), t("", { covered: true }), t("", { covered: true })],
  ];
  const vals = [[412000, 398500, 455200, 1200000], [305400, 322900, 341000, 1000000], [288100, 301700, 296400, 950000], [356800, 349200, 372600, 1050000], [198300, 210400, 225900, 600000]];
  regions.forEach((r, i) => {
    const row = i + 3;
    grid.push([t(r), n(String(vals[i][0])), n(String(vals[i][1])), n(String(vals[i][2])), f(`=SUM(B${row}:D${row})`), n(String(vals[i][3])), f(`=ROUND(E${row}/F${row}*100,1)`)]);
  });
  const last = regions.length + 2;
  grid.push([t("Total", { bold: true }), f(`=SUM(B3:B${last})`, true), f(`=SUM(C3:C${last})`, true), f(`=SUM(D3:D${last})`, true), f(`=SUM(E3:E${last})`, true), f(`=SUM(F3:F${last})`, true), f(`=ROUND(E${last + 1}/F${last + 1}*100,1)`, true)]);

  const products: GridCell[][] = [[h("Product line"), h("Units"), h("Revenue (USD)"), h("Share %")]];
  const pl = [["Hardware", 1840, 1835600], ["Software licences", 920, 1406300], ["Support contracts", 610, 812500], ["Training", 240, 189400]];
  pl.forEach((p, i) => products.push([t(String(p[0])), n(String(p[1])), n(String(p[2])), f(`=ROUND(C${i + 2}/C${pl.length + 2}*100,1)`)]));
  products.push([t("Total", { bold: true }), f(`=SUM(B2:B${pl.length + 1})`, true), f(`=SUM(C2:C${pl.length + 1})`, true), f(`=SUM(D2:D${pl.length + 1})`, true)]);

  return {
    version: 1,
    page: { size: "a4", orientation: "portrait", marginsMm: { top: 20, right: 18, bottom: 20, left: 18 }, header: "Quarterly Sales Report — {{quarter}} {{year}}", footer: "Page {{page}} of {{pages}}", fontSizePt: 11 },
    params: [
      { name: "year", label: "Year", defaultValue: "2025" },
      { name: "quarter", label: "Quarter", defaultValue: "Q2" },
    ],
    sections: [
      section("Cover", [
        { id: uid(), type: "spacer", heightMm: 60 },
        { id: uid(), type: "heading", level: 1, text: "Quarterly Sales Report", align: "center", noToc: true },
        { id: uid(), type: "paragraph", text: "**{{quarter}} {{year}}**", align: "center", sizePt: 16 },
        { id: uid(), type: "spacer", heightMm: 20 },
        { id: uid(), type: "paragraph", text: "Prepared by the Sales Operations team", align: "center" },
      ]),
      section("Contents", [{ id: uid(), type: "toc", title: "Contents", maxLevel: 2 }]),
      section("Summary", [
        { id: uid(), type: "heading", level: 1, text: "1. Executive summary" },
        { id: uid(), type: "paragraph", text: "Revenue for {{quarter}} {{year}} grew across all regions. The **North** region again led in absolute terms, while *Central* posted the fastest growth.\n\nThe tables below compare monthly revenue with the quarterly target. Totals and attainment are calculated with formulas, so editing any figure updates them automatically." },
        { id: uid(), type: "heading", level: 2, text: "1.1 Revenue by product line" },
        { id: uid(), type: "table", grid: products, headerRows: 1, colWidths: [3, 1.2, 1.6, 1.2] },
      ]),
      section("Regional detail", [
        { id: uid(), type: "heading", level: 1, text: "2. Regional detail" },
        { id: uid(), type: "paragraph", text: "Monthly revenue, quarter total and target attainment by region. This section is printed on landscape pages." },
        { id: uid(), type: "table", title: "Table 2.1 Revenue by region", grid, headerRows: 2, colWidths: [2, 1.4, 1.4, 1.4, 1.6, 1.4, 1.2] },
      ], { orientation: "landscape" }),
      section("Outlook", [
        { id: uid(), type: "heading", level: 1, text: "3. Outlook" },
        { id: uid(), type: "paragraph", text: "Pipeline coverage for the next quarter stands at 3.1× target. Key risks are longer procurement cycles in the public sector and currency movements in export markets." },
        { id: uid(), type: "divider" },
        { id: uid(), type: "paragraph", text: "*Figures are unaudited and may be revised.*", sizePt: 9 },
      ]),
    ],
  };
}

function projectStatus(): DocContent {
  const ms: GridCell[][] = [[h("Milestone"), h("Owner"), h("Due"), h("Status")]];
  [["Requirements signed off", "Product", "Week 2", "Done"], ["Design review", "Engineering", "Week 4", "Done"], ["Beta release", "Engineering", "Week 9", "On track"], ["Customer pilot", "Customer success", "Week 12", "At risk"], ["General availability", "Product", "Week 16", "Planned"]]
    .forEach((r) => ms.push(r.map((x) => t(x))));
  return {
    version: 1,
    page: { size: "letter", orientation: "portrait", marginsMm: { top: 20, right: 20, bottom: 20, left: 20 }, footer: "{{project}} — page {{page}}", fontSizePt: 11 },
    params: [{ name: "project", label: "Project", defaultValue: "Project Atlas" }, { name: "period", label: "Reporting period", defaultValue: "March 2025" }],
    sections: [section("Status", [
      { id: uid(), type: "heading", level: 1, text: "{{project}} — status report" },
      { id: uid(), type: "paragraph", text: "Reporting period: **{{period}}**" },
      { id: uid(), type: "heading", level: 2, text: "Milestones" },
      { id: uid(), type: "table", grid: ms, headerRows: 1, colWidths: [3, 2, 1, 1.4] },
      { id: uid(), type: "heading", level: 2, text: "Risks and issues" },
      { id: uid(), type: "paragraph", text: "The customer pilot depends on a third-party integration that is two weeks late. Mitigation: run the pilot on the previous integration version." },
    ])],
  };
}

export const TEMPLATES: { id: string; name: string; description: string; build: () => DocContent }[] = [
  { id: "blank", name: "Blank document", description: "One section, A4 portrait", build: blankContent },
  { id: "quarterly-sales", name: "Quarterly Sales Report", description: "Cover, contents, formula tables, landscape section", build: quarterlySales },
  { id: "project-status", name: "Project Status Report", description: "Letter size, milestones table, parameters", build: projectStatus },
];
