// Engine + status presentation model (mirrors prototype config.jsx / data.jsx).
import type { IconName } from "@/components/Icon";

export interface EngineDef {
  label: string;
  th: string;
  icon: IconName;
  color: string;
  ext: string;
  desc: string;
}

export const ENGINES: Record<string, EngineDef> = {
  jasper: { label: "Jasper", th: "Jasper template", icon: "doc", color: "#c0392b", ext: "jrxml", desc: "JRXML template rendered by the Jasper engine" },
  api: { label: "API", th: "External API", icon: "link", color: "#285f9c", ext: "json", desc: "Fetch from a REST/SOAP service (e.g. External Finance API)" },
  sql: { label: "SQL", th: "SQL query", icon: "datasource", color: "#1a7a48", ext: "sql", desc: "Direct SQL query rendered to tabular output" },
  composite: { label: "Composite", th: "Multi-source", icon: "layers", color: "#6b4fd6", ext: "yml", desc: "Combines Jasper sub-reports + API/SQL sources" },
  component: { label: "Component", th: "OneWeb component", icon: "engine", color: "#0c8276", ext: "yml", desc: "Installed engine — routes to the OneWeb component export API" },
  http: { label: "HTTP", th: "Remote HTTP engine", icon: "gateway", color: "#5a6a7a", ext: "json", desc: "Generic HTTP engine — POSTs to a configured remote endpoint" },
  other: { label: "Other", th: "Information only", icon: "doc", color: "#7a6a5a", ext: "txt", desc: "Free-text app-module notes — no template, not rendered" },
  fetch: { label: "Fetch", th: "Download file", icon: "download", color: "#b06a1f", ext: "pdf", desc: "Downloads a ready-made file by URL/id (1-step) or generate→id→download (2-step)" },
};

export const engineDef = (e: string): EngineDef => ENGINES[e] ?? ENGINES.jasper;

export const PIPELINE: { id: string; label: string; sub: string; icon: IconName }[] = [
  { id: "ingress", label: "API Gateway", sub: "REST ingress", icon: "gateway" },
  { id: "queue", label: "Kafka Queue", sub: "topic: report.jobs", icon: "queue" },
  { id: "worker", label: "Worker Pool", sub: "8 consumers", icon: "worker" },
  { id: "jasper", label: "Jasper Engine", sub: "render JRXML", icon: "engine" },
  { id: "store", label: "Output Store", sub: "S3 / MinIO", icon: "store" },
];

export type Tone = "green" | "amber" | "red" | "slate" | "blue" | "violet";

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "green" },
  testing: { label: "Testing", tone: "amber" },
  draft: { label: "Draft", tone: "slate" },
  error: { label: "Error", tone: "red" },
  healthy: { label: "Healthy", tone: "green" },
  degraded: { label: "Degraded", tone: "amber" },
  down: { label: "Down", tone: "red" },
};
