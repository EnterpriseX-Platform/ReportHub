"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Breadcrumb, BreadcrumbItem, Content, Header, HeaderGlobalAction, HeaderGlobalBar, HeaderMenu,
  HeaderMenuButton, HeaderMenuItem, HeaderName, HeaderNavigation, HeaderPanel, Search, SideNav,
  SideNavItems, SideNavLink, SideNavMenu, SideNavMenuItem, SkipToContent, Switcher, SwitcherDivider,
  SwitcherItem, Tag, Tile,
} from "@carbon/react";
import {
  Catalog, Close, Dashboard, DataBase, Document, Flash, Notification, Renew, Search as SearchIcon,
  Settings, UserAvatar,
} from "@carbon/icons-react";
import { ICONS, type IconName } from "./Icon";
import { api, errorStatus, getProject, setProject, setToken } from "@/lib/api";
import { PermsContext, permsFrom } from "@/lib/perms";
import type { MeResponse, TenancyMine } from "@/lib/types";
import { useToast } from "./Toast";

/** obj = IAM object code whose "view" permission shows the menu entry. */
type NavItem = { href: string; label: string; icon: IconName; obj: string; badge?: "registered" | "queue"; admin?: boolean };
type NavGroup = { group: string; icon: ComponentType; items: NavItem[] };
const NAV: NavGroup[] = [
  { group: "Overview", icon: Dashboard, items: [{ href: "/", obj: "RH.OVERVIEW", label: "Overview", icon: "dashboard" }] },
  {
    group: "Reports", icon: Catalog,
    items: [
      { href: "/registry", obj: "RH.REPORT", label: "Report Registry", icon: "registry", badge: "registered" },
      { href: "/runtask", obj: "RH.REPORT", label: "Run Task", icon: "tester" },
      { href: "/outputs", obj: "RH.OUTPUT", label: "Output Files", icon: "viewer" },
      { href: "/parameters", obj: "RH.REPORT.PARAMETER", label: "Parameters", icon: "filter" },
      { href: "/queue", obj: "RH.QUEUE", label: "Queue Monitor", icon: "queue", badge: "queue" },
    ],
  },
  {
    group: "Data", icon: DataBase,
    items: [
      { href: "/repository", obj: "RH.REPOSITORY", label: "Tables", icon: "database" },
      { href: "/datasets", obj: "RH.DATASET", label: "Datasets", icon: "table" },
      { href: "/adhocreport", obj: "RH.ADHOC", label: "Ad-hoc Report", icon: "adhoc" },
    ],
  },
  {
    group: "Automation", icon: Flash,
    items: [
      { href: "/datapipeline", obj: "RH.PIPELINE", label: "Data Pipeline", icon: "store" },
      { href: "/checks", obj: "RH.CHECK", label: "Data Checks", icon: "check" },
      { href: "/schedulers", obj: "RH.SCHEDULER", label: "Scheduled SQL", icon: "calendar" },
    ],
  },
  {
    group: "Publishing", icon: Document,
    items: [
      // /adhoc and /workbench are off the menu but still reachable by URL.
      { href: "/dashboards", obj: "RH.DASHBOARD", label: "Dashboards", icon: "grid" },
      { href: "/documents", obj: "RH.DOCUMENT", label: "Documents", icon: "viewer" },
    ],
  },
  {
    group: "Administration", icon: Settings,
    items: [
      { href: "/integrations", obj: "RH.INTEGRATION|RH.DATASOURCE|RH.ENGINE", label: "Integrations", icon: "link" },
      { href: "/settings", obj: "RH.SETTINGS", label: "Settings", icon: "settings", admin: true },
    ],
  },
];

const ROUTE_META: Record<string, { crumb: string; title: string }> = {
  "/": { crumb: "Overview", title: "Overview" },
  "/registry": { crumb: "Reports", title: "Report Registry" },
  "/runtask": { crumb: "Reports", title: "Run Task" },
  "/tester": { crumb: "Reports", title: "Run Task" },
  "/parameters": { crumb: "Reports", title: "Parameters" },
  "/outputs": { crumb: "Reports", title: "Output Files" },
  "/queue": { crumb: "Reports", title: "Queue Monitor" },
  "/listreport": { crumb: "Reports", title: "Report List" },
  "/flow": { crumb: "Reports", title: "Flow Designer" },
  "/datasources": { crumb: "Administration", title: "Integrations" },
  "/datasets": { crumb: "Data", title: "Datasets" },
  "/repository": { crumb: "Data", title: "Tables" },
  "/adhocreport": { crumb: "Data", title: "Ad-hoc Report" },
  "/sqleditor": { crumb: "Data", title: "Ad-hoc Report" },
  "/adhoc": { crumb: "Data", title: "Ad-hoc Report" },
  "/workbench": { crumb: "Data", title: "Analyze" },
  "/datapipeline": { crumb: "Automation", title: "Data Pipeline" },
  "/checks": { crumb: "Automation", title: "Data Checks" },
  "/chains": { crumb: "Automation", title: "Job Chains" },
  "/schedulers": { crumb: "Automation", title: "Scheduled SQL" },
  "/dashboards": { crumb: "Publishing", title: "Dashboards" },
  "/documents": { crumb: "Publishing", title: "Documents" },
  "/engines": { crumb: "Administration", title: "Integrations" },
  "/integrations": { crumb: "Administration", title: "Integrations" },
  "/settings": { crumb: "Administration", title: "Settings" },
};

/** Screens that are off the menu but still guarded by an object code. */
const EXTRA_OBJ: Record<string, string> = {
  "/tester": "RH.REPORT", "/listreport": "RH.REPORT", "/flow": "RH.REPORT",
  "/datasources": "RH.INTEGRATION|RH.DATASOURCE", "/engines": "RH.INTEGRATION|RH.ENGINE",
  "/sqleditor": "RH.ADHOC", "/adhoc": "RH.ADHOC", "/workbench": "RH.DATASET", "/chains": "RH.PIPELINE",
};

/** Carbon lg breakpoint: below it the side nav is an overlay opened from the header menu button. */
const LG = 1056;

function NoAccess({ obj }: { obj: string }) {
  return (
    <Tile style={{ maxWidth: 560 }}>
      <h2 className="cds--type-heading-03">No access</h2>
      <p className="cds--type-body-01" style={{ marginTop: 8, color: "var(--cds-text-secondary)" }}>
        You do not have permission to view this screen (requires <code className="cds--type-code-01">{obj}</code> view).
      </p>
    </Tile>
  );
}

type Panel = null | "search" | "notifications" | "user";

/** /login with the page the user was on (?next=), so signing in returns there. Paths are basePath-relative. */
function loginUrl(): string {
  if (typeof window === "undefined") return "/login";
  const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  const here = window.location.pathname + window.location.search;
  const rel = base && here.startsWith(base) ? here.slice(base.length) || "/" : here;
  return rel === "/" || rel.startsWith("/login") ? "/login" : `/login?next=${encodeURIComponent(rel)}`;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  /** Desktop: false = full side nav, true = 48px rail. Below lg: true = overlay open. */
  const [navToggled, setNavToggled] = useState(false);
  const [wide, setWide] = useState(true);
  const [panel, setPanel] = useState<Panel>(null);
  const [badges, setBadges] = useState<{ registered: number; queue: number }>({ registered: 0, queue: 0 });
  const [me, setMe] = useState<MeResponse | null>(null);
  const [tenancy, setTenancy] = useState<TenancyMine | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking
  // Set after mount only: window is not there during SSR.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    try { setEmbedded(window.self !== window.top); } catch { setEmbedded(true); } // cross-origin throw = framed
  }, []);

  // /print/* is the bare document page the PDF exporter renders (authorised by its print key, not a session).
  const isLogin = pathname === "/login" || pathname.startsWith("/share/") || pathname.startsWith("/print/");

  // Route guard: ask the server who we are; only a failed /auth/me sends us to /login.
  // With no rs.token we still ask, because under EDGE AUTH the gateway proxy injects
  // the portal user's token server-side; no token and no portal session = 401 = /login.
  useEffect(() => {
    if (isLogin) { setAuthed(true); return; }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = () => api.me()
      .then((m) => { if (!cancelled) { setMe(m); setAuthed(true); } })
      .catch((e) => {
        if (cancelled) return;
        // Only 401 means "signed out". A 400/5xx/network failure keeps the token and retries.
        if (errorStatus(e) === 401) { setToken(null); setAuthed(false); router.replace(loginUrl()); return; }
        retry = setTimeout(ask, 5000);
      });
    ask();
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, isLogin]);

  // Track the Carbon lg breakpoint; the overlay menu and header panels close on navigation.
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${LG}px)`);
    const h = () => { setWide(mq.matches); setNavToggled(false); };
    setWide(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  useEffect(() => { setPanel(null); if (!wide) setNavToggled(false); }, [pathname, wide]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPanel(null);
      if (window.innerWidth < LG) setNavToggled(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Any API call hitting a 401 routes back to login.
  useEffect(() => {
    const h = () => { if (pathname !== "/login") router.replace(loginUrl()); };
    window.addEventListener("rs-unauthorized", h);
    return () => window.removeEventListener("rs-unauthorized", h);
  }, [pathname, router]);

  // Tenant + project for the switcher. A remembered project that no longer exists is dropped
  // (the API signals it with X-Project-Fallback → "rs-project-fallback"); project edits in
  // Settings fire "rs-tenancy-changed" so a new project shows up without a reload.
  const [tenancyRev, setTenancyRev] = useState(0);
  useEffect(() => {
    const h = () => setTenancyRev((n) => n + 1);
    window.addEventListener("rs-project-fallback", h);
    window.addEventListener("rs-tenancy-changed", h);
    return () => { window.removeEventListener("rs-project-fallback", h); window.removeEventListener("rs-tenancy-changed", h); };
  }, []);
  useEffect(() => {
    if (isLogin || authed !== true) return;
    api.tenancyMine()
      .then(setTenancy)
      .catch(() => {
        if (!getProject()) return;
        setProject(null);
        api.tenancyMine().then(setTenancy).catch(() => {});
      });
  }, [isLogin, authed, tenancyRev]);

  useEffect(() => {
    if (isLogin || authed !== true) return;
    api.dashboard()
      .then((d) => setBadges({ registered: d.stats.registered, queue: d.stats.inQueue }))
      .catch(() => {});
  }, [isLogin, authed, tenancy?.project, pathname]);

  const isAdmin = me?.role === "ADMIN" || !!me?.admin;
  const perms = useMemo(() => {
    const base = permsFrom(me);
    // A nav/route object may list alternatives ("A|B"): any one grants view.
    return { ...base, can: (code: string, action?: string) => code.split("|").some((c) => base.can(c, action)) };
  }, [me]);
  const nav = useMemo(() => NAV
    .map((g) => ({ ...g, items: g.items.filter((it) => perms.can(it.obj) && (!it.admin || isAdmin || perms.can(it.obj, "update"))) }))
    .filter((g) => g.items.length), [perms, isAdmin]);

  if (isLogin) return <>{children}</>;
  if (authed !== true) return <div style={{ minHeight: "100vh" }} />;

  // Embedded in the host portal iframe: the portal already draws the shell, so render just the page.
  if (embedded) return <div className="rh-content rh-embedded">{children}</div>;

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const meta = ROUTE_META[pathname] ?? Object.entries(ROUTE_META).find(([k]) => k !== "/" && pathname.startsWith(k))?.[1] ?? ROUTE_META["/"];
  // Screen-level permission for the current route: a direct URL to a forbidden screen gets "No access".
  const routeObj = (() => {
    if (pathname === "/") return "RH.OVERVIEW";
    const hit = NAV.flatMap((g) => g.items).filter((it) => it.href !== "/" && pathname.startsWith(it.href))
      .sort((a, b) => b.href.length - a.href.length)[0];
    return hit?.obj ?? EXTRA_OBJ[Object.keys(EXTRA_OBJ).find((k) => pathname.startsWith(k)) ?? ""] ?? null;
  })();
  const denied = !!routeObj && !perms.can(routeObj);
  const rail = wide && navToggled;
  const navOpen = wide ? !navToggled : navToggled;
  const togglePanel = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  return (
    <PermsContext.Provider value={perms}>
      <Header aria-label="Report Studio">
        <SkipToContent />
        <HeaderMenuButton
          aria-label={navOpen ? "Close menu" : "Open menu"}
          isActive={!wide && navToggled}
          isCollapsible
          aria-expanded={navOpen}
          onClick={() => setNavToggled((t) => !t)}
        />
        <HeaderName as={NextLink} href="/" prefix="">Report Studio</HeaderName>
        {tenancy && <ProjectMenu tenancy={tenancy} />}
        <HeaderGlobalBar>
          <HeaderGlobalAction aria-label="Search" tooltipAlignment="end" isActive={panel === "search"} onClick={() => togglePanel("search")}>
            {panel === "search" ? <Close size={20} /> : <SearchIcon size={20} />}
          </HeaderGlobalAction>
          <HeaderGlobalAction aria-label="Notifications" tooltipAlignment="end" isActive={panel === "notifications"} onClick={() => togglePanel("notifications")}>
            <Notification size={20} />
          </HeaderGlobalAction>
          <HeaderGlobalAction aria-label="Refresh" tooltipAlignment="end" onClick={() => router.refresh()}>
            <Renew size={20} />
          </HeaderGlobalAction>
          <HeaderGlobalAction aria-label={me?.displayName ?? "User"} tooltipAlignment="end" isActive={panel === "user"} onClick={() => togglePanel("user")}>
            <UserAvatar size={20} />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
        <HeaderPanel expanded={panel === "search"} aria-label="Search" className="rh-hpanel">
          {panel === "search" && <ScreenSearch nav={nav} onGo={(href) => { setPanel(null); router.push(href); }} />}
        </HeaderPanel>
        <HeaderPanel expanded={panel === "notifications"} aria-label="Notifications" className="rh-hpanel">
          <div className="rh-hpanel-pad">
            <h3 className="cds--type-heading-compact-01">Notifications</h3>
            {perms.can("RH.QUEUE") && badges.queue > 0 ? (
              <NextLink href="/queue" className="cds--link" style={{ display: "block", marginTop: 12 }}>
                {badges.queue} job{badges.queue === 1 ? "" : "s"} in the queue
              </NextLink>
            ) : (
              <p className="cds--type-body-compact-01" style={{ marginTop: 12, color: "var(--cds-text-secondary)" }}>No new notifications</p>
            )}
          </div>
        </HeaderPanel>
        <HeaderPanel expanded={panel === "user"} aria-label="User" className="rh-hpanel">
          {panel === "user" && <UserPanel me={me} tenancy={tenancy} />}
        </HeaderPanel>
        <SideNav
          aria-label="Side navigation"
          expanded={navOpen}
          isRail={rail}
          onOverlayClick={() => setNavToggled(false)}
          onSideNavBlur={() => { if (!wide) setNavToggled(false); }}
          href="#main-content"
        >
          <SideNavItems>
            {nav.map((g) => {
              if (g.group === "Overview") {
                const it = g.items[0];
                return (
                  <SideNavLink key={g.group} as={NextLink} href={it.href} renderIcon={g.icon} isActive={isActive(it.href)}>
                    {it.label}
                  </SideNavLink>
                );
              }
              const groupActive = g.items.some((it) => isActive(it.href));
              return (
                <SideNavMenu key={g.group} title={g.group} renderIcon={g.icon} defaultExpanded isActive={groupActive}>
                  {g.items.map((it) => {
                    const n = it.badge === "registered" ? badges.registered : it.badge === "queue" ? badges.queue : null;
                    return (
                      <SideNavMenuItem key={it.href} as={NextLink} href={it.href} isActive={isActive(it.href)}
                                       aria-current={isActive(it.href) ? "page" : undefined}>
                        <span className="rh-nav-label">{it.label}</span>
                        {n != null && <Tag size="sm" type={isActive(it.href) ? "blue" : "gray"} className="rh-nav-badge">{n}</Tag>}
                      </SideNavMenuItem>
                    );
                  })}
                </SideNavMenu>
              );
            })}
          </SideNavItems>
        </SideNav>
      </Header>
      <Content id="main-content" className={"rh-content" + (rail ? " rh-content--rail" : "")}>
        {meta.crumb !== meta.title && (
          <Breadcrumb noTrailingSlash className="rh-breadcrumb">
            <BreadcrumbItem>{meta.crumb}</BreadcrumbItem>
            <BreadcrumbItem isCurrentPage>{meta.title}</BreadcrumbItem>
          </Breadcrumb>
        )}
        {denied ? <NoAccess obj={routeObj!} /> : children}
      </Content>
    </PermsContext.Provider>
  );
}

/** Find a screen by name from the header search: Enter opens the first match. */
function ScreenSearch({ nav, onGo }: { nav: NavGroup[]; onGo: (href: string) => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const all = nav.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));
  const hits = q ? all.filter((it) => (it.label + " " + it.group).toLowerCase().includes(q.toLowerCase())) : all;
  return (
    <div>
      <Search ref={ref} size="lg" labelText="Search screens" placeholder="Search screens" value={q}
              onChange={(e) => setQ((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) onGo(hits[0].href); }} />
      <Switcher aria-label="Screens" className="rh-search-hits">
        {hits.map((it) => {
          const I = ICONS[it.icon];
          return (
            <SwitcherItem key={it.href} aria-label={it.label} onClick={() => onGo(it.href)}>
              <I size={16} /> <span>{it.label}</span><span className="rh-dim">{it.group}</span>
            </SwitcherItem>
          );
        })}
      </Switcher>
    </div>
  );
}

/**
 * Project switcher as a Carbon HeaderMenu. Tenant is fixed by the sign-in; the project is sent as
 * X-Project on every call. Switching reloads so every screen re-reads its data in the new project.
 * Below lg the header navigation is hidden by Carbon; the same list is in the user panel.
 */
function ProjectMenu({ tenancy }: { tenancy: TenancyMine }) {
  const current = tenancy.projects.find((p) => p.id === tenancy.project);
  return (
    <HeaderNavigation aria-label="Project">
      <HeaderMenu aria-label={`Project: ${current?.name ?? tenancy.project}`} menuLinkName={`Project: ${current?.name ?? tenancy.project}`}>
        {tenancy.projects.map((p) => (
          <HeaderMenuItem key={p.id} href="#" isActive={p.id === tenancy.project}
            onClick={(e: React.MouseEvent) => { e.preventDefault(); switchProject(tenancy, p.id); }}>
            {p.name}
          </HeaderMenuItem>
        ))}
      </HeaderMenu>
    </HeaderNavigation>
  );
}

function switchProject(tenancy: TenancyMine, id: string) {
  if (id === tenancy.project) return;
  setProject(id);
  window.location.reload();
}

function UserPanel({ me, tenancy }: { me: MeResponse | null; tenancy: TenancyMine | null }) {
  const toast = useToast();
  async function logout() {
    await api.logout();
    setToken(null);
    setProject(null);
    toast("Signed out", "ok");
    // Full navigation, so no screen keeps rendering with the old session's state.
    window.location.replace("/login");
  }
  const role = isAdminOf(me) ? "Administrator" : "Analyst";
  return (
    <div>
      <div className="rh-hpanel-pad">
        <div className="cds--type-heading-compact-01">{me?.displayName ?? "—"}</div>
        <div className="cds--type-label-01 rh-dim">{me?.username} · {role}{me?.tenant && me.tenant !== "default" ? ` · ${me.tenant}` : ""}</div>
      </div>
      <Switcher aria-label="User">
        {tenancy && tenancy.projects.length > 1 && <>
          <li className="rh-switcher-label cds--type-label-01">Project</li>
          {tenancy.projects.map((p) => (
            <SwitcherItem key={p.id} aria-label={p.name} isSelected={p.id === tenancy.project} onClick={() => switchProject(tenancy, p.id)}>
              {p.name}
            </SwitcherItem>
          ))}
          <SwitcherDivider />
        </>}
        <SwitcherItem aria-label="Sign out" onClick={logout}>Sign out</SwitcherItem>
      </Switcher>
    </div>
  );
}

const isAdminOf = (me: MeResponse | null) => me?.role === "ADMIN" || !!me?.admin;
