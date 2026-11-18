// Lightweight build-tag endpoint the in-page reload guard polls (see layout.tsx).
// Returns the BUILD_ID baked into THIS server. If the client's compiled-in
// NEXT_PUBLIC_BUILD_ID differs, the client knows it's running stale JS and reloads.
// Must be dynamic — otherwise Next.js would serve a prerendered snapshot of an
// older build.

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  const id = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
  return new Response(id, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}
