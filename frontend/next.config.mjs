// Base path is build-time and env-driven: set NEXT_BASE_PATH=/report-studio for SIT/prod
// (served under https://host/report-studio); leave it unset for local dev (served at /).
const basePath = process.env.NEXT_BASE_PATH;

// Build-tagged so a redeploy produces a NEW chunk hash + a NEW value the client can compare
// against, which lets the runtime detect stale browser tabs and force-reload (see layout.tsx).
// Without this, an open tab from before a deploy can keep loading the OLD bundle indefinitely
// — that bundle still sends raw multipart and gets 403'd by the UAT Cloudflare WAF.
const BUILD_ID = process.env.BUILD_ID || `dev-${Date.now()}`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lean container image: emits .next/standalone with a self-contained server.js
  output: "standalone",
  generateBuildId: async () => BUILD_ID,
  // Inlined into the client bundle so `process.env.NEXT_PUBLIC_BUILD_ID` is the
  // build tag everywhere a component checks "am I current?"
  // NEXT_PUBLIC_BASE_PATH is also inlined so the reload-guard script in layout.tsx
  // can build absolute URLs that work after deploy (the runtime container doesn't
  // re-export NEXT_BASE_PATH, so SSR-time `process.env.NEXT_BASE_PATH` is empty).
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
    NEXT_PUBLIC_BASE_PATH: basePath || "",
  },
  // Make sure no proxy / browser ever caches a page that points at OLD chunk hashes.
  // The hashed _next/static/ assets are immutable by content and safe to cache — only
  // the HTML entry needs to stay fresh, because that's what wires the chunk URLs.
  async headers() {
    return [
      {
        source: '/((?!_next/static/).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
        ],
      },
    ];
  },
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
