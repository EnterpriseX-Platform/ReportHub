"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, type IconName } from "./Icon";
import { api, getToken, setToken } from "@/lib/api";
import { useToast } from "./Toast";

type NavItem = { href: string; label: string; icon: IconName; badge?: "registered" | "queue"; live?: boolean; admin?: boolean };
const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Overview", items: [{ href: "/", label: "Overview", icon: "dashboard" }] },
  {
    group: "Report Operations",
    items: [
      { href: "/registry", label: "Report Registry", icon: "registry", badge: "registered" },
      { href: "/runtask", label: "Run Task", icon: "tester" },
      { href: "/parameters", label: "Parameters", icon: "filter" },
      { href: "/outputs", label: "Output Files", icon: "viewer" },
      { href: "/queue", label: "Queue Monitor", icon: "queue", badge: "queue", live: true },
    ],
  },
  {
    group: "Data & Analytics",
    items: [
      { href: "/datasources", label: "Datasources", icon: "datasource" },
      { href: "/datasets", label: "Datasets", icon: "table" },
      { href: "/repository", label: "Repository", icon: "database" },
      { href: "/adhoc", label: "Ad-hoc Builder", icon: "adhoc" },
      { href: "/workbench", label: "Analytics Workbench", icon: "workbench" },
      { href: "/dashboards", label: "Dashboards", icon: "grid" },
    ],
  },
  {
    group: "Automation",
    items: [
      { href: "/warehouse", label: "Data Warehouse", icon: "store" },
      { href: "/schedulers", label: "Schedulers", icon: "calendar" },
    ],
  },
  {
    group: "Platform",
    items: [
      { href: "/engines", label: "Engines", icon: "engine" },
      { href: "/settings", label: "Settings", icon: "settings", admin: true },
    ],
  },
];

const ROUTE_META: Record<string, { crumb: string; title: string }> = {
  "/": { crumb: "Overview", title: "Overview" },
  "/registry": { crumb: "Report Operations", title: "Report Registry" },
  "/runtask": { crumb: "Report Operations", title: "Run Task" },
  "/tester": { crumb: "Report Operations", title: "Run Task" },
  "/parameters": { crumb: "Report Operations", title: "Parameters" },

  "/outputs": { crumb: "Report Operations", title: "Output Files" },
  "/queue": { crumb: "Report Operations", title: "Queue Monitor" },
  "/datasources": { crumb: "Data & Analytics", title: "Datasources" },
  "/datasets": { crumb: "Data & Analytics", title: "Datasets" },
  "/repository": { crumb: "Data & Analytics", title: "Repository" },
  "/warehouse": { crumb: "Automation", title: "Data Warehouse" },
  "/schedulers": { crumb: "Automation", title: "Schedulers" },
  "/dashboards": { crumb: "Data & Analytics", title: "Dashboards" },
  "/adhoc": { crumb: "Data & Analytics", title: "Ad-hoc Report Builder" },
  "/workbench": { crumb: "Data & Analytics", title: "Analytics Workbench" },
  "/engines": { crumb: "Platform", title: "Engines" },
  "/settings": { crumb: "Platform", title: "Settings" },
};

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [badges, setBadges] = useState<{ registered: number; queue: number }>({ registered: 0, queue: 0 });
  const [me, setMe] = useState<{ username: string; role: string; displayName: string } | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking

  const isLogin = pathname === "/login" || pathname.startsWith("/share/");

  // Route guard: no token (or stale token) → /login. Re-checked on every navigation.
  useEffect(() => {
    if (isLogin) { setAuthed(true); return; }
    const token = getToken();
    if (!token) {
      setAuthed(false);
      router.replace("/login");
      return;
    }
    let cancelled = false;
    api.me()
      .then((m) => { if (!cancelled) { setMe(m); setAuthed(true); } })
      .catch(() => { if (!cancelled) { setToken(null); setAuthed(false); router.replace("/login"); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, isLogin]);

  // Any API call hitting a 401 routes back to login.
  useEffect(() => {
    const h = () => { if (pathname !== "/login") router.replace("/login"); };
    window.addEventListener("rs-unauthorized", h);
    return () => window.removeEventListener("rs-unauthorized", h);
  }, [pathname, router]);

  useEffect(() => {
    if (isLogin || authed !== true) return;
    api.dashboard()
      .then((d) => setBadges({ registered: d.stats.registered, queue: d.stats.inQueue }))
      .catch(() => {});
  }, [isLogin, authed]);

  // The login page renders bare (no sidebar/topbar).
  if (isLogin) return <>{children}</>;
  if (authed !== true) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <span className="spin" />
      </div>
    );
  }

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const meta = ROUTE_META[pathname] ?? Object.entries(ROUTE_META).find(([k]) => k !== "/" && pathname.startsWith(k))?.[1] ?? ROUTE_META["/"];
  const isAdmin = me?.role === "ADMIN";

  return (
    <div className="app">
      <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
        <div className="brand">
          <div className="brand-mark"><Icon name="chart" size={18} /></div>
          <div>
            <div className="brand-name">Report Studio</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group-label">{g.group}</div>
              {g.items.filter((it) => !it.admin || isAdmin).map((it) => {
                const active = isActive(it.href);
                const badgeVal = it.badge === "registered" ? badges.registered : it.badge === "queue" ? badges.queue : null;
                return (
                  <Link key={it.href} href={it.href} className={"nav-item" + (active ? " active" : "")} title={it.label}>
                    <Icon name={it.icon} size={18} />
                    <span>{it.label}</span>
                    {it.badge && (
                      <span className="nav-badge">
                        {it.live && (
                          <i className="pulse" style={{ display: "inline-block", width: 5, height: 5, borderRadius: 5, background: "var(--green)", marginRight: 5, verticalAlign: "middle" }} />
                        )}
                        {badgeVal}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
            <Icon name="sidebar" size={17} />
            <span>{collapsed ? "" : "Collapse"}</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn sidebar-toggle" title="Menu" onClick={() => setCollapsed((c) => !c)} style={{ display: "none" }}>
            <Icon name="sidebar" size={18} />
          </button>
          <div className="crumbs">

            {meta.crumb !== meta.title && (<><span>{meta.crumb}</span>
            <span className="sep"><Icon name="chevron" size={13} /></span></>)}
            <b>{meta.title}</b>
          </div>
          <div className="topbar-spacer" />
          <div className="search">
            <Icon name="search" size={16} />
            <input placeholder="Search reports, jobs, datasources…" />
            <kbd>/</kbd>
          </div>
          <button className="icon-btn" title="Notifications"><Icon name="bell" size={18} /><span className="dot" /></button>
          <button className="icon-btn" title="Refresh" onClick={() => router.refresh()}><Icon name="refresh" size={18} /></button>
          <div style={{ width: 1, height: 28, background: "var(--line)" }} />
          <UserMenu me={me} />
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

function UserMenu({ me }: { me: { username: string; role: string; displayName: string } | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  function logout() {
    setOpen(false);
    setToken(null);
    toast("Signed out", "ok");
    router.replace("/login");
  }

  const initials = (me?.displayName ?? me?.username ?? "?")
    .split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <div className="role-switch" onClick={() => setOpen((o) => !o)}>
        <div className="role-av">{initials}</div>
        <div className="role-meta">
          <b>{me?.displayName ?? "—"}</b>
          <span>{me?.role === "ADMIN" ? "Administrator" : "Analyst"}</span>
        </div>
        <Icon name="chevDown" size={15} style={{ color: "var(--ink-4)" }} />
      </div>
      {open && (
        <div className="menu">
          <div className="menu-h">{me?.username}</div>
          <div className="menu-item" onClick={logout}>
            <Icon name="x" size={15} />
            <div style={{ fontWeight: 600 }}>Sign out</div>
          </div>
        </div>
      )}
    </div>
  );
}
