"use client";

// "Tester & Preview" is now "Run Task" — keep old links (/tester?code=…) working.
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function TesterRedirect() {
  return (
    <Suspense fallback={null}>
      <Redirect />
    </Suspense>
  );
}

function Redirect() {
  const router = useRouter();
  const search = useSearchParams();
  useEffect(() => {
    const code = search.get("code");
    router.replace(code ? `/runtask?code=${encodeURIComponent(code)}` : "/runtask");
  }, [router, search]);
  return null;
}
