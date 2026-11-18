"use client";

import { useState } from "react";
import { Button, Form, Layer, InlineNotification, PasswordInput, Stack, TextInput, Tile } from "@carbon/react";
import { ArrowRight, ChartColumn } from "@carbon/icons-react";
import { api, errorStatus, fieldErrors, setToken } from "@/lib/api";

/** Where to go after sign-in: ?next= when it is a same-app path, else Overview. */
function target(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  let next = "/";
  try {
    const n = new URLSearchParams(window.location.search).get("next");
    // Only app-relative paths: no scheme, no protocol-relative //host, never back to /login.
    if (n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && !n.startsWith("/login")) next = n;
  } catch { /* default */ }
  return base + next;
}

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fErr, setFErr] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password || busy) return;
    setBusy(true);
    setErr(null);
    setFErr({});
    try {
      const res = await api.login(username.trim(), password);
      setToken(res.token);
      // Full navigation (not router.replace): the shell re-runs its auth check with the new token,
      // and a soft navigation racing the guard's own redirect can no longer leave us on /login.
      window.location.replace(target());
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : "Sign-in failed";
      setFErr(fieldErrors(ex));
      // 429 = too many failed attempts; the server says how long the lockout lasts.
      setErr(errorStatus(ex) === 429 && !/try again/i.test(msg)
        ? "Too many failed sign-in attempts. Wait a few minutes and try again." : msg);
      setBusy(false);
    }
  }

  return (
    <main className="rh-login">
      <div className="rh-login__col">
        <div className="rh-login__brand">
          <span className="rh-login__mark"><ChartColumn size={20} /></span>
          <span className="cds--type-heading-03">Report Studio</span>
        </div>
        <Tile className="rh-login__tile">
          <Layer><Form onSubmit={submit}>
            <Stack gap={6}>
              <h1 className="cds--type-productive-heading-04" style={{ margin: 0 }}>Sign in</h1>
              <TextInput id="login-username" labelText="Username" autoFocus autoComplete="username" size="lg"
                         value={username} onChange={(e) => setUsername(e.target.value)}
                         invalid={!!fErr.username} invalidText={fErr.username} />
              <PasswordInput id="login-password" labelText="Password" autoComplete="current-password" size="lg"
                             value={password} onChange={(e) => setPassword(e.target.value)}
                             invalid={!!fErr.password} invalidText={fErr.password} />
              {err && <InlineNotification kind="error" title={err} hideCloseButton lowContrast />}
              <Button type="submit" renderIcon={ArrowRight} disabled={busy || !username || !password} className="rh-login__submit">
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </Stack>
          </Form></Layer>
        </Tile>
      </div>
    </main>
  );
}
