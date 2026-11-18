"use client";

// Bare print page rendered by the document exporter (engines/document-exporter) to make the PDF.
// Reads the document through the public print endpoint with the signed print token the exporter
// was given (?token=…, scoped to one document, tenant/project and the requesting user), then sets
// window.__DOC_READY__ once pagination has settled (or window.__DOC_ERROR__ on failure).
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { docApi } from "@/lib/api";
import type { PrintPayload } from "@/lib/document/types";
import { DocPages } from "@/components/document/DocPages";

declare global {
  interface Window { __DOC_READY__?: boolean; __DOC_ERROR__?: string }
}

export default function PrintPage() {
  return <Suspense fallback={null}><Print /></Suspense>;
}

function Print() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const [payload, setPayload] = useState<PrintPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    docApi.print(id, search.toString())
      .then(setPayload)
      .catch((e) => { const m = e instanceof Error ? e.message : "Load failed"; setError(m); window.__DOC_ERROR__ = m; });
  }, [id, search]);

  if (error) return <div style={{ padding: 24 }}>Cannot load document: {error}</div>;
  if (!payload) return null;
  return (
    <div className="doc-print-root">
      <DocPages content={payload.document.content} params={payload.params} data={payload.data}
        onReady={() => { window.__DOC_READY__ = true; }} />
    </div>
  );
}
