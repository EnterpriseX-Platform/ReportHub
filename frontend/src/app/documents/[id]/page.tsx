"use client";

import { useParams } from "next/navigation";
import { DocEditor } from "@/components/document/DocEditor";

export default function DocumentEditorPage() {
  const { id } = useParams<{ id: string }>();
  return <DocEditor id={Number(id)} />;
}
