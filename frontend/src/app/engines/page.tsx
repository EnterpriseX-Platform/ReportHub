"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Moved into Integrations; old links keep working. */
export default function Redirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/integrations?category=engines"); }, [router]);
  return null;
}
