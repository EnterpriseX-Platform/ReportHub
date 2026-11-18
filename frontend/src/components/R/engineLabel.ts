import { engineDef } from "@/lib/model";

/** Engine kinds that have no entry in ENGINES but still need a proper display name. */
const EXTRA: Record<string, string> = { book: "Book", docbuilder: "Doc builder", other: "Other" };

/** One display label per engine kind, used by every Group R list so the same engine reads the same everywhere. */
export function engineLabel(kind: string): string {
  return EXTRA[kind] ?? engineDef(kind).label;
}
