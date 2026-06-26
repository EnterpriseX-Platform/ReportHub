// Warehouse presentation model (labels for fact dimensions/measures)
// + ad-hoc dataset families. Values themselves live in the database.

export const FISCAL_YEAR = 2026;

export const WB_DIMENSIONS = [
  { id: "region", label: "Region" },
  { id: "category", label: "Category" },
  { id: "channel", label: "Channel" },
  { id: "year", label: "Fiscal Year" },
];

export const WB_MEASURES = [
  { id: "target", label: "Target" },
  { id: "sales", label: "Sales" },
  { id: "profit", label: "Profit" },
];

// Ad-hoc dataset families
export const ADHOC_DATASETS = [
  { id: "d-core", label: "Warehouse data", sub: "Core data warehouse", ds: "ds-core" },
  { id: "d-province", label: "Regional data", sub: "Regional records", ds: "ds-province" },
  { id: "d-activity", label: "Activity-level data", sub: "Output / activity detail", ds: "ds-core" },
  { id: "d-kpi", label: "Indicator (KPI) data", sub: "Targets & performance", ds: "ds-core" },
  { id: "d-ext", label: "External finance data", sub: "External interface extract", ds: "ds-ext" },
];
