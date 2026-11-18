import { redirect } from "next/navigation";

/**
 * Legacy path of this screen, now at /adhocreport. Kept as a redirect so old links and
 * bookmarks do not turn into a 404.
 */
export default function SqlEditorMoved() {
  redirect("/adhocreport");
}
