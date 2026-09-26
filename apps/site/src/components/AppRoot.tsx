import { useCallback, useEffect, useRef, useState } from "react";
import { SITE } from "../config";
import type { SseConnectionStatus } from "../lib/sse";
import { useWalletSession } from "../lib/useWalletSession";
import AccountView from "./account/AccountView";
import PromisesView, { PromisesSkeleton } from "./app/PromisesView";
import SignInGate from "./app/SignInGate";
import LiveView, { LiveSkeleton } from "./dashboard/LiveView";
import AppShell from "./ui/AppShell";

type View = "promises" | "live" | "account";

function routeFor(view: View): string {
  if (view === "live") return SITE.dashboardRoute;
  if (view === "account") return SITE.accountRoute;
  return SITE.appRoute;
}

function viewForPathname(pathname: string): View {
  if (pathname === SITE.dashboardRoute) return "live";
  if (pathname === SITE.accountRoute) return "account";
  return "promises";
}

interface LiveFilterRequest {
  id: string | undefined;
  token: number;
}

interface AppRootProps {
  /** Which tab the current document was rendered for (`/app`, `/app/dashboard`
   * or `/app/account`) — also this island's server-rendered and first-client
   * render, so hydration matches exactly (see `app.astro` / `dashboard.astro`
   * / `account.astro`). */
  initialView: View;
  /** Dev-mode absolute path to `apps/mcp/index.ts`, forwarded to the key
   * handoff's local MCP config snippet. Only ever set on `/app`. */
  entryPath?: string;
}

/**
 * The single React island behind both `/app` and `/app/dashboard` (P5).
 *
 * Before this, each route was its own Astro page mounting its own island
 * (`AppFlow`/`PromisesView` today, `DashboardApp`/`LiveView` today), so every
 * switch between Promises and Live was a full document reload: React
 * remounted from scratch, `useWalletSession` re-ran `/auth/me`, and whichever
 * tab you landed on refetched its data from zero even though you'd just left
 * it.
 *
 * `AppRoot` is now the one island both Astro pages mount, `initialView`
 * saying which tab this particular document is for. It:
 *  - owns `useWalletSession()` once, so the session is verified on document
 *    load and never again just from switching tabs;
 *  - keeps a tab mounted forever once the owner has visited it (hidden with
 *    the `hidden` attribute, never unmounted), so the Live tab's SSE stream
 *    and both tabs' already-fetched data survive a switch;
 *  - turns every in-app link between the two routes into
 *    `history.pushState` + a view flip instead of a document navigation, via
 *    one delegated click listener rather than threading a `navigate` prop
 *    through `AppShell`'s tabs, `PromiseList`'s "Watch live" cards and the
 *    Live empty state's links — all of which stay completely unchanged
 *    (`PromiseList.tsx` in particular is being edited on a parallel branch,
 *    so not touching it at all keeps that rebase simple). The key handoff's
 *    "Open Live" button isn't a link, so it calls `onOpenLive` directly.
 *
 * `/app` and `/app/dashboard` keep working as real URLs — a fresh load, a
 * refresh, or a shared link (including `?promise=<id>`) still renders the
 * right tab server-side — and `popstate` (back/forward) re-derives the view
 * and the Live promise filter from the address bar exactly like the old full
 * reload did.
 */
export default function AppRoot({ initialView, entryPath }: AppRootProps) {
  const session = useWalletSession();
  const [view, setView] = useState<View>(initialView);
  const [visited, setVisited] = useState<Set<View>>(() => new Set([initialView]));
  const [liveStatus, setLiveStatus] = useState<SseConnectionStatus>("connecting");
  const [liveFilterRequest, setLiveFilterRequest] = useState<LiveFilterRequest | undefined>();
  const navToken = useRef(0);

  const goTo = useCallback((next: View, targetUrl?: string) => {
    const url = new URL(targetUrl ?? routeFor(next), window.location.origin);
    const target = url.pathname + url.search;
    const current = window.location.pathname + window.location.search;
    if (target !== current) window.history.pushState({ view: next }, "", target);
    window.scrollTo({ top: 0 });
    setView(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    if (next === "live") {
      navToken.current += 1;
      setLiveFilterRequest({ id: url.searchParams.get("promise") ?? undefined, token: navToken.current });
    }
  }, []);

  // Browser back/forward: the address bar just changed under us, so
  // re-derive the view (and, landing on Live, its promise filter) from it.
  useEffect(() => {
    function onPopState() {
      const next: View = viewForPathname(window.location.pathname);
      setView(next);
      setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
      if (next === "live") {
        navToken.current += 1;
        setLiveFilterRequest({ id: new URLSearchParams(window.location.search).get("promise") ?? undefined, token: navToken.current });
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // One delegated click listener stands in for per-component navigation:
  // any in-app <a href="/app"> / <a href="/app/dashboard[?promise=...]">
  // anywhere in the tree — AppShell's tabs, PromiseList's "Watch live"
  // cards, Live's empty-state links — becomes a view flip instead of a
  // document load, without changing any of those components.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target instanceof Element ? e.target.closest("a") : null;
      if (!anchor || (anchor.target && anchor.target !== "_self")) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      let url: URL;
      try {
        url = new URL(href, window.location.origin);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === SITE.appRoute) {
        e.preventDefault();
        goTo("promises", url.pathname + url.search);
      } else if (url.pathname === SITE.dashboardRoute) {
        e.preventDefault();
        goTo("live", url.pathname + url.search);
      } else if (url.pathname === SITE.accountRoute) {
        e.preventDefault();
        goTo("account", url.pathname + url.search);
      }
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [goTo]);

  useEffect(() => {
    document.title = view === "live" ? `Live — ${SITE.name}` : view === "account" ? `Account — ${SITE.name}` : `Promises — ${SITE.name}`;
  }, [view]);

  const openLive = useCallback(() => goTo("live"), [goTo]);

  return (
    <AppShell active={view} session={session} liveStatus={view === "live" ? liveStatus : undefined}>
      {session.stage.kind === "signed-in" ? (
        <>
          <div hidden={view !== "promises"}>
            {visited.has("promises") && (
              <PromisesView
                key={session.stage.sessionToken}
                address={session.stage.address}
                sessionToken={session.stage.sessionToken}
                entryPath={entryPath}
                onOpenLive={openLive}
              />
            )}
          </div>
          <div hidden={view !== "live"}>
            {visited.has("live") && (
              <LiveView
                key={session.stage.sessionToken}
                sessionToken={session.stage.sessionToken}
                onUnauthorized={session.handleUnauthorized}
                onLiveStatus={setLiveStatus}
                filterRequest={liveFilterRequest}
              />
            )}
          </div>
          <div hidden={view !== "account"}>
            {visited.has("account") && (
              <AccountView key={session.stage.sessionToken} sessionToken={session.stage.sessionToken} onUnauthorized={session.handleUnauthorized} />
            )}
          </div>
        </>
      ) : session.stage.kind === "checking" ? (
        view === "live" ? (
          <LiveSkeleton />
        ) : (
          <PromisesSkeleton />
        )
      ) : (
        <SignInGate session={session} />
      )}
    </AppShell>
  );
}
