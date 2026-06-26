"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { api, setToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.login(username.trim(), password);
      setToken(res.token);
      router.replace("/");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg-deep)", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "center", marginBottom: 26 }}>
          <div className="brand-mark" style={{ width: 40, height: 40, borderRadius: 11 }}><Icon name="chart" size={22} /></div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.3px" }}>Report Studio</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Report registry &amp; gateway console</div>
          </div>
        </div>

        <form className="card card-pad" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 15, padding: 26 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Sign in</div>

          <div className="field">
            <label>Username</label>
            <input
              className="input"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {err && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--red)", background: "color-mix(in srgb, var(--red) 8%, transparent)", padding: "9px 12px", borderRadius: 8 }}>
              <Icon name="alert" size={15} />{err}
            </div>
          )}

          <button className="btn primary" style={{ height: 42 }} disabled={busy || !username || !password}>
            {busy ? <><span className="spin" />Signing in…</> : <>Sign in</>}
          </button>

        </form>
      </div>
    </div>
  );
}
