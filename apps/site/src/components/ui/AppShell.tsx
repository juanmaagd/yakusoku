import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { SITE } from "../../config";
import { fetchOwnerControl, pauseOwnerSigning, resumeOwnerSigning, UnauthorizedError, type OwnerControlState } from "../../lib/api";
import { shortAddress } from "../../lib/format";
import type { SseConnectionStatus } from "../../lib/sse";
import type { WalletSession } from "../../lib/useWalletSession";
import { smallButton } from "../../lib/ui";
import ConfirmInline from "./ConfirmInline";
import { IconCheck, IconChevronDown, IconCopy, IconPause, IconPlay } from "./Icons";

// --- Per-owner kill switch, shared by the top bar and the Live view --------

export interface OwnerControl {
  control: OwnerControlState;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

const OwnerControlContext = createContext<OwnerControl | undefined>(undefined);

/** The signed-in owner's pause state (`/me/control`), or `undefined` while
 * signed out. The firewall's owner-scoped SSE stream never carries
 * `control.changed`, so this state only moves through our own calls. */
export function useOwnerControl(): OwnerControl | undefined {
  return useContext(OwnerControlContext);
}

type Section = "promises" | "live" | "account";

interface AppShellProps {
  active: Section;
  session: WalletSession;
  /** Live stream status, known only on the Live view. */
  liveStatus?: SseConnectionStatus;
  children: ReactNode;
}

/** The frame every /app route shares: logo, the section tabs, the global
 * "Pause all" switch and the wallet chip. Signed out, only the logo shows and
 * the page content is the sign-in gate. */
export default function AppShell({ active, session, liveStatus, children }: AppShellProps) {
  const signedIn = session.stage.kind === "signed-in" ? session.stage : undefined;
  const sessionToken = signedIn?.sessionToken;
  const { handleUnauthorized } = session;
  const [control, setControl] = useState<OwnerControlState>({ paused: false });

  const rethrowUnlessUnauthorized = useCallback(
    (err: unknown) => {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      throw err;
    },
    [handleUnauthorized],
  );

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    fetchOwnerControl(sessionToken)
      .then((next) => {
        if (!cancelled) setControl(next);
      })
      .catch((err) => {
        if (err instanceof UnauthorizedError) handleUnauthorized();
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken, handleUnauthorized]);

  const pause = useCallback(async () => {
    if (!sessionToken) return;
    try {
      setControl(await pauseOwnerSigning(sessionToken, "paused from the app"));
    } catch (err) {
      rethrowUnlessUnauthorized(err);
    }
  }, [sessionToken, rethrowUnlessUnauthorized]);

  const resume = useCallback(async () => {
    if (!sessionToken) return;
    try {
      setControl(await resumeOwnerSigning(sessionToken));
    } catch (err) {
      rethrowUnlessUnauthorized(err);
    }
  }, [sessionToken, rethrowUnlessUnauthorized]);

  const ownerControl = sessionToken ? { control, pause, resume } : undefined;

  return (
    <OwnerControlContext.Provider value={ownerControl}>
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-8 px-6 md:px-8">
          <a href="/" className="flex shrink-0 items-center" aria-label={`${SITE.name} home`}>
            <img src="/brand/logo.svg" alt={SITE.name} width="144" height="24" className="h-6 w-auto" />
          </a>
          {signedIn && (
            <nav aria-label="App" className="hidden h-full md:flex">
              <Tabs active={active} liveStatus={liveStatus} />
            </nav>
          )}
          {signedIn && ownerControl && (
            <div className="ml-auto flex items-center gap-3">
              <div className="hidden md:block">
                <PauseControl {...ownerControl} />
              </div>
              <WalletChip address={signedIn.address} onSignOut={session.signOut} />
            </div>
          )}
        </div>
        {signedIn && ownerControl && (
          <div className="flex h-12 items-center justify-between gap-3 border-t border-hairline px-6 md:hidden">
            <nav aria-label="App" className="flex h-full">
              <Tabs active={active} liveStatus={liveStatus} />
            </nav>
            <PauseControl {...ownerControl} />
          </div>
        )}
      </header>
      <main className="frame min-h-[calc(100vh-64px)] px-6 pb-20 pt-10 md:px-10 md:pt-12">{children}</main>
    </OwnerControlContext.Provider>
  );
}

function Tabs({ active, liveStatus }: { active: Section; liveStatus?: SseConnectionStatus }) {
  const tabs: { id: Section; label: string; href: string }[] = [
    { id: "promises", label: "Intents", href: SITE.appRoute },
    { id: "live", label: "Live", href: SITE.dashboardRoute },
    { id: "account", label: "Account", href: SITE.accountRoute },
  ];
  return (
    <ul className="flex h-full items-stretch gap-6">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <li key={tab.id} className="flex">
            <a
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              className={`relative inline-flex items-center gap-2 text-body-sm transition-colors duration-200 ease-out ${
                isActive
                  ? "font-medium text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-ink"
                  : "text-graphite hover:text-ink"
              }`}
            >
              {tab.label}
              {tab.id === "live" && liveStatus === "connected" && (
                <span className="size-1.5 rounded-full bg-verified" role="img" aria-label="Live stream connected" />
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

const popover = "absolute right-0 top-[calc(100%+8px)] z-50 w-[min(320px,calc(100vw-48px))] rounded-card border border-hairline bg-surface p-4 shadow-console";

function PauseControl({ control, pause, resume }: OwnerControl) {
  const [confirming, setConfirming] = useState(false);
  const [resuming, setResuming] = useState(false);
  const close = useCallback(() => setConfirming(false), []);
  const ref = useDismiss(confirming, close);

  if (control.paused) {
    return (
      <button
        type="button"
        disabled={resuming}
        onClick={async () => {
          setResuming(true);
          try {
            await resume();
          } finally {
            setResuming(false);
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-btn border border-refuse/60 bg-refuse-wash px-3 py-1.5 text-body-sm leading-[1.2] font-medium text-refuse-ink transition-colors duration-200 ease-out hover:border-refuse"
      >
        <IconPlay size={14} />
        {resuming ? "Resuming…" : "Paused · Resume"}
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={confirming} onClick={() => setConfirming((v) => !v)} className={smallButton}>
        <IconPause size={14} />
        Pause all
      </button>
      {confirming && (
        <div className={popover}>
          <ConfirmInline
            message="Pause every agent? The firewall refuses to sign for any of your intents until you resume."
            confirmLabel="Pause all"
            busyLabel="Pausing…"
            onConfirm={async () => {
              await pause();
              setConfirming(false);
            }}
            onCancel={close}
          />
        </div>
      )}
    </div>
  );
}

function WalletChip({ address, onSignOut }: { address: string; onSignOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-btn border border-hairline-strong px-3 py-1.5 transition-colors duration-200 ease-out hover:border-ink"
      >
        <span className="size-1.5 rounded-full bg-ink" aria-hidden="true" />
        <span className="font-mono text-caption text-ink">{shortAddress(address)}</span>
        <span className="hidden text-caption text-graphite lg:inline">{SITE.network}</span>
        <IconChevronDown size={14} className="text-graphite" />
      </button>
      {open && (
        <div role="menu" className={`${popover} w-60 p-1.5`}>
          <p className="px-2.5 pb-2 pt-1.5 font-mono text-caption break-all text-graphite">{address}</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyAddress()}
            className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-body-sm text-ink hover:bg-fog"
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            {copied ? "Copied" : "Copy address"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void onSignOut();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-body-sm text-ink hover:bg-fog"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
