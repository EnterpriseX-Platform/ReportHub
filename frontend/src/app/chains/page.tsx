"use client";

// Job Chains now live as a tab inside Pipelines; this route is kept so old links and
// bookmarks still open.
import { ChainsPanel } from "@/components/ChainsPanel";

export default function ChainsPage() {
  return <ChainsPanel />;
}
