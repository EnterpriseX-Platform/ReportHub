import { redirect } from "next/navigation";

/**
 * Legacy route /warehouse — moved to /datapipeline.
 * Kept as a redirect so existing menu entries and bookmarks do not 404.
 */
export default function WarehouseMoved() {
  redirect("/datapipeline");
}
