#!/usr/bin/env node
// Import ReportHub's IAM object codes into the IAM service.
//
//   node docs/iam/import-objects.mjs <objects.json> --base <IAM base URL> --module <IAM module id>
//        [--types menu=<objectTypeId>,api=<objectTypeId>]
//
// IAM stores an object's type as objectTypeId (a UUID of an ObjectType row whose code is e.g.
// MENU / PAGE / API). The script resolves each object's type code to that id: first from --types
// (or IAM_OBJECT_TYPES), then from the IAM API (/api/object-types or /api/objecttypes when the
// service exposes one). A type that cannot be resolved stops the import with a clear message,
// instead of sending the code where an id is expected.
//
// <objects.json> is the file from ReportHub: Settings → IAM connection → Export JSON
// (GET /api/iam/objects/export). The IAM bearer token is read from the IAM_TOKEN environment
// variable. Objects whose code already exists in the module are skipped, so the script can be
// re-run after ReportHub adds new codes. Parents are created before their children.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const base = (opt("base") ?? process.env.IAM_BASE_URL ?? "").replace(/\/+$/, "");
const moduleId = opt("module") ?? process.env.IAM_MODULE_ID;
const token = process.env.IAM_TOKEN;
if (!file || !base || !moduleId || !token) {
  console.error("usage: IAM_TOKEN=... node import-objects.mjs <objects.json> --base <url> --module <moduleId>");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(file, "utf8"));
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json.data;
}

// --- object type code -> id
const typeIdByCode = new Map();
const typesArg = opt("types") ?? process.env.IAM_OBJECT_TYPES;
if (typesArg) {
  for (const pair of typesArg.split(",")) {
    const [code, id] = pair.split("=").map((x) => x?.trim());
    if (code && id) typeIdByCode.set(code.toUpperCase(), id);
  }
}
for (const path of ["/api/object-types", "/api/objecttypes"]) {
  try {
    const list = await call("GET", path);
    for (const t of Array.isArray(list) ? list : []) if (t.code && t.id) typeIdByCode.set(String(t.code).toUpperCase(), t.id);
    break;
  } catch { /* endpoint not available on this IAM version */ }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function typeId(code) {
  if (!code) return undefined;
  if (UUID.test(code)) return code;
  const id = typeIdByCode.get(String(code).toUpperCase());
  if (!id) {
    console.error(`Unknown IAM object type '${code}'. Pass its id: --types ${String(code).toLowerCase()}=<objectTypeId>`);
    process.exit(3);
  }
  return id;
}
// fail before creating anything
for (const o of doc.objects) typeId(o.objectType);

const existing = await call("GET", `/api/objects?moduleId=${encodeURIComponent(moduleId)}`);
const idByCode = new Map(existing.map((o) => [o.code, o.id]));

// parents first
const pending = [...doc.objects];
let created = 0, skipped = 0;
while (pending.length) {
  const i = pending.findIndex((o) => !o.parentCode || idByCode.has(o.parentCode));
  if (i < 0) throw new Error(`unresolvable parent for ${pending.map((o) => o.code).join(", ")}`);
  const o = pending.splice(i, 1)[0];
  if (idByCode.has(o.code)) { skipped++; continue; }
  const made = await call("POST", "/api/objects", {
    moduleId,
    code: o.code,
    name: o.name,
    description: `ReportHub ${o.route ?? ""} · actions: ${o.actions.join(", ")}`.trim(),
    type: typeId(o.objectType),
    status: "active",
    ...(o.parentCode ? { parentId: idByCode.get(o.parentCode) } : {}),
  });
  idByCode.set(o.code, made.id);
  created++;
  console.log(`created ${o.code}`);
}
console.log(`done: ${created} created, ${skipped} already present`);
