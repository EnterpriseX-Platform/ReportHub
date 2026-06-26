import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { ToastHost } from "@/components/Toast";

const plexThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-thai",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Report Studio",
  description: "Report registry & gateway console",
};

// Force this layout (and every page that inherits it) to re-render on every request.
// Combined with the `Cache-Control: no-store` headers in next.config.mjs, this guarantees
// the HTML entry that wires the chunk URLs is never served from cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
// Use NEXT_PUBLIC_BASE_PATH (inlined at build time via next.config.mjs); falling back to
// NEXT_BASE_PATH would silently miss the prefix at runtime, because the prod container
// doesn't re-export it — the guard then fetches /version.txt at the host root, hits the
// edge's catch-all redirect, parses the redirect HTML as a "different build", and reloads
// in a 10s loop. Witnessed live: Tawan's Register wizard reloaded every ~15s.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

// Inline guard: on tab focus, fetch /version.txt — if the server reports a different
// BUILD_ID than the one we compiled in, the bundle this tab is running is stale
// (probably from before a deploy), so reload. Critical for UAT: stale bundles still
// send raw multipart and trip the Cloudflare WAF on .jrxml uploads.
const RELOAD_GUARD = `(function(){
  var BUILD=${JSON.stringify(BUILD_ID)};
  if(!BUILD||/^dev/.test(BUILD))return;
  var BASE=${JSON.stringify(BASE_PATH)};
  var k='rs_reload_at';
  function reload(reason){
    try{var now=Date.now();var last=+sessionStorage.getItem(k)||0;
      if(now-last<60000)return; sessionStorage.setItem(k,String(now));}catch(e){}
    console.warn('[reportstudio] reloading stale bundle:',reason);
    location.reload();
  }
  function check(){
    fetch(BASE+'/version.txt?t='+Date.now(),{cache:'no-store',redirect:'error'})
      .then(function(r){
        if(!r.ok)return null;
        var ct=(r.headers.get('content-type')||'').toLowerCase();
        // Only trust a plain-text response from our own /version.txt route — if a proxy
        // serves HTML (login page, error, redirect target), don't treat that body as a tag.
        if(ct.indexOf('text/plain')<0)return null;
        return r.text();
      })
      .then(function(t){
        if(!t)return;
        var live=t.trim();
        // A valid tag is short and looks like v<digits>.<digits>.<digits>; anything else
        // is some HTML / error / accidental match — don't reload on that.
        if(live.length>32||!/^[A-Za-z0-9._-]+$/.test(live))return;
        if(live!==BUILD)reload('build '+BUILD+' vs '+live);
      })
      .catch(function(){});
  }
  document.addEventListener('visibilitychange',function(){if(!document.hidden)check();});
  window.addEventListener('pageshow',function(e){if(e.persisted)check();});
  if(document.readyState==='complete')setTimeout(check,1500);
  else window.addEventListener('load',function(){setTimeout(check,1500);});
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" data-skin="console" className={`${plexThai.variable} ${plexMono.variable}`}>
      <head>
        {/* Last-ditch hint for stubborn proxies that ignore the Cache-Control header
            from next.config — meta http-equiv is read by the browser itself. */}
        <meta httpEquiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0" />
        <meta httpEquiv="Pragma" content="no-cache" />
        <meta httpEquiv="Expires" content="0" />
        <script dangerouslySetInnerHTML={{ __html: RELOAD_GUARD }} />
      </head>
      <body>
        <ToastHost>
          <AppShell>{children}</AppShell>
        </ToastHost>
      </body>
    </html>
  );
}
