import { useEffect, useMemo, useRef, useState } from "react";
import tutorials from "../../lib/tutorials.json";
import tutorialChapters from "../../lib/tutorial-chapters.json";
import { IconCross, IconExpand, IconMinus, IconPause, IconPlay } from "./Icons";

export type TutorialTopic = keyof typeof tutorials;

type Chapter = { start: number; duration: number; title: string; text: string };
type Phase = "closed" | "opening" | "open" | "closing";

const STORAGE_KEY = "omamorisan.tutorialDock";

/** Timing is owned by the recorder's chapters.json; titles/text stay in tutorials.json. */
function chaptersFor(topic: TutorialTopic): Chapter[] {
  const timing = tutorialChapters[topic].chapters;
  const steps = tutorials[topic].steps;
  return timing.map((entry, index) => ({
    start: entry.start,
    duration: entry.duration,
    title: (steps[index]?.title ?? entry.title).replace(/^\d+\.\s*/, ""),
    text: steps[index]?.text ?? "",
  }));
}

function formatTime(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function indexForTime(time: number, chapters: Chapter[]): number {
  if (chapters.length === 0) return 0;
  return Math.max(0, chapters.findIndex((chapter, i) => time < chapter.start + chapter.duration || i === chapters.length - 1));
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function readMinimizedPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "min";
  } catch {
    return false;
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** A minimizable dock that opens into a side panel (desktop) or bottom sheet (mobile). */
export default function TutorialVideo({ topic }: { topic: TutorialTopic }) {
  const tutorial = tutorials[topic];
  const chapters = useMemo(() => chaptersFor(topic), [topic]);
  const totalDuration = tutorialChapters[topic].duration;
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const [phase, setPhase] = useState<Phase>("closed");
  const [minimized, setMinimized] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [entranceReady, setEntranceReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [time, setTime] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const player = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const panelRootRef = useRef<HTMLElement | null>(null);
  const activeIndexRef = useRef(0);
  const prevPhaseRef = useRef<Phase>("closed");

  const setPanelRoot = (node: HTMLElement | null) => {
    panelRootRef.current = node;
  };

  function updateProgress(currentTime: number) {
    const nextIndex = indexForTime(currentTime, chapters);
    if (nextIndex !== activeIndexRef.current) {
      activeIndexRef.current = nextIndex;
      setActiveIndex(nextIndex);
    }
    const root = panelRootRef.current;
    if (!root) return;
    const progress = totalDuration > 0 ? clamp01(currentTime / totalDuration) : 0;
    root.style.setProperty("--progress", String(progress));
    const chapter = chapters[nextIndex];
    const phaseProgress = chapter && chapter.duration > 0 ? clamp01((currentTime - chapter.start) / chapter.duration) : 0;
    root.style.setProperty("--phase-progress", String(phaseProgress));
  }

  function togglePlay() {
    const video = player.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }

  function seek(index: number) {
    const chapter = chapters[index];
    const video = player.current;
    if (!chapter || !video) return;
    video.currentTime = chapter.start;
    setTime(chapter.start);
    updateProgress(chapter.start);
    void video.play().catch(() => {});
  }

  function handleScrub(value: string) {
    const nextTime = Number(value);
    const video = player.current;
    if (video) video.currentTime = nextTime;
    setTime(nextTime);
    updateProgress(nextTime);
  }

  function toggleCaptions() {
    const next = !captionsOn;
    const track = trackRef.current?.track;
    if (track) track.mode = next ? "showing" : "hidden";
    setCaptionsOn(next);
  }

  function toggleFullscreen() {
    const el = stageRef.current;
    if (!el) return;
    void el.requestFullscreen?.().catch(() => {});
  }

  function openPanel() {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHasInteracted(true);
    setPhase("opening");
  }

  function closePanel() {
    if (phase === "closed" || phase === "closing") return;
    player.current?.pause();
    setPhase("closing");
    openerRef.current?.focus();
  }

  function minimizeDock() {
    setHasInteracted(true);
    setMinimized(true);
    try {
      localStorage.setItem(STORAGE_KEY, "min");
    } catch {
      /* storage unavailable; the in-memory state still reflects the choice */
    }
  }

  // Restore a previously minimized dock without risking a hydration mismatch on first paint.
  useEffect(() => {
    if (readMinimizedPreference()) setMinimized(true);
  }, []);

  // The dock eases in once, shortly after the page settles.
  useEffect(() => {
    const timeout = window.setTimeout(() => setEntranceReady(true), 500);
    return () => window.clearTimeout(timeout);
  }, []);

  // Autoplay only ever starts from the user's own click that opened the panel.
  useEffect(() => {
    if (prevPhaseRef.current === "closed" && phase !== "closed") {
      const video = player.current;
      if (video) {
        if (time > 0) video.currentTime = time;
        void video.play().catch(() => {});
      }
    }
    prevPhaseRef.current = phase;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== "opening") return;
    const raf = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    if (phase !== "closing") return;
    const timeout = window.setTimeout(() => setPhase("closed"), 260);
    return () => window.clearTimeout(timeout);
  }, [phase]);

  useEffect(() => {
    if (phase === "open") closeButtonRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (phase === "closed") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    if (isDesktop) {
      document.body.classList.add("tutorial-side-open");
      return () => {
        window.removeEventListener("keydown", onKeyDown);
        document.body.classList.remove("tutorial-side-open");
      };
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isDesktop]);

  useEffect(() => {
    if (phase === "closed") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeItemRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [activeIndex, phase]);

  // Smooth progress: drive CSS vars every frame while playing instead of re-rendering per frame.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      const video = player.current;
      if (video) updateProgress(video.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, chapters, totalDuration]);

  const panelVisible = phase !== "closed";
  const activeChapter = chapters[activeIndex];
  const showSwap = hasInteracted;
  const dockMotionClass = showSwap ? "tutorial-swap-in" : "tutorial-dock-in";
  const dockHidden = showSwap ? undefined : !entranceReady;

  const openLabel = `Open ${tutorial.title} walkthrough`;

  const panelBody = (
    <>
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline px-4 py-3 md:px-5">
        <h2 className="min-w-0 line-clamp-2 text-heading-sm font-normal text-ink">{tutorial.title}</h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={closePanel}
          aria-label="Close walkthrough"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-btn text-graphite transition-colors hover:bg-fog hover:text-ink"
        >
          <IconCross size={16} />
        </button>
      </div>

      <div className="shrink-0 border-b border-hairline bg-fog p-3 md:p-4">
        <div ref={stageRef} className="relative overflow-hidden rounded-card border border-hairline bg-fog">
          <video
            ref={player}
            muted
            playsInline
            preload="metadata"
            poster={`/tutorials/${topic}.jpg`}
            aria-label={tutorial.title}
            onClick={togglePlay}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              updateProgress(player.current?.currentTime ?? 0);
            }}
            onLoadedMetadata={() => {
              const video = player.current;
              if (!video) return;
              if (time > 0) video.currentTime = time;
              if (trackRef.current) trackRef.current.track.mode = captionsOn ? "showing" : "hidden";
              updateProgress(video.currentTime);
            }}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onSeeked={(event) => updateProgress(event.currentTarget.currentTime)}
            className="aspect-video w-full bg-ink object-contain"
          >
            <source src={`/tutorials/${topic}.mp4`} type="video/mp4" />
            <track ref={trackRef} kind="captions" src={`/tutorials/${topic}.vtt`} srcLang="en" label="English" />
            <a href={`/tutorials/${topic}.mp4`}>Download the walkthrough</a>
          </video>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            tabIndex={playing ? -1 : 0}
            aria-hidden={playing}
            className={`tutorial-stage-play absolute inset-0 flex items-center justify-center transition-opacity duration-150 ${playing ? "pointer-events-none opacity-0" : "opacity-100"}`}
          >
            <span className="flex size-14 items-center justify-center rounded-btn bg-ink text-surface">
              <IconPlay size={22} />
            </span>
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="flex size-8 shrink-0 items-center justify-center rounded-btn bg-ink text-surface transition-colors hover:bg-charcoal"
          >
            {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
          </button>
          <span className="label shrink-0 tabular-nums text-graphite">
            {formatTime(time)} / {formatTime(totalDuration)}
          </span>
          <div className="group relative order-first h-4 basis-full sm:order-none sm:flex-1 sm:basis-0">
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-sm bg-hairline-strong">
              <div className="tutorial-progress-fill h-full bg-ink" />
              {chapters.slice(1).map((chapter) => (
                <span key={chapter.title} className="absolute top-0 h-full w-px bg-canvas" style={{ left: `${(chapter.start / totalDuration) * 100}%` }} />
              ))}
            </div>
            <div
              aria-hidden="true"
              className="tutorial-progress-thumb pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
            />
            <input
              type="range"
              min={0}
              max={totalDuration}
              step={0.1}
              value={time}
              onChange={(event) => handleScrub(event.target.value)}
              aria-label="Seek"
              aria-valuetext={`${formatTime(time)} of ${formatTime(totalDuration)}, step ${activeIndex + 1}: ${activeChapter?.title ?? ""}`}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </div>
          <span className="label ml-auto shrink-0 tabular-nums text-graphite sm:ml-0">
            {String(activeIndex + 1).padStart(2, "0")} / {String(chapters.length).padStart(2, "0")}
          </span>
          <button
            type="button"
            onClick={toggleCaptions}
            aria-pressed={captionsOn}
            className={`label shrink-0 rounded-sm border px-1.5 py-1 transition-colors ${captionsOn ? "border-ink text-ink" : "border-hairline-strong text-graphite hover:border-ink hover:text-ink"}`}
          >
            CC
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label="Fullscreen"
            className="flex size-8 shrink-0 items-center justify-center rounded-btn border border-hairline-strong text-graphite transition-colors hover:border-ink hover:text-ink"
          >
            <IconExpand size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4 md:px-5" aria-label="Video phases">
        <ol className="divide-y divide-hairline border-y border-hairline">
          {chapters.map((chapter, index) => {
            const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "upcoming";
            return (
              <li key={chapter.title} ref={index === activeIndex ? activeItemRef : undefined}>
                <button
                  type="button"
                  aria-current={state === "active" ? "step" : undefined}
                  onClick={() => seek(index)}
                  className={`relative w-full overflow-hidden px-3 py-3.5 text-left transition-colors ${state === "active" ? "bg-fog" : "bg-surface hover:bg-fog"}`}
                >
                  <span className="flex items-center gap-3">
                    <span
                      className={`label flex size-6 shrink-0 items-center justify-center ${state === "active" ? "rounded-sm bg-ink text-surface" : state === "done" ? "text-ink" : "text-stone"}`}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="text-body-sm font-medium text-ink">{chapter.title}</span>
                    <span className="label ml-auto shrink-0 tabular-nums text-graphite">{formatTime(chapter.start)}</span>
                  </span>
                  <span className="mt-2 block pl-9 text-body-sm text-graphite">{chapter.text}</span>
                  {state === "active" && <span aria-hidden="true" className="tutorial-phase-progress absolute inset-x-0 bottom-0 h-0.5 bg-ink" />}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-hairline pt-4">
          <span className="label text-stone">Example data · No real payment</span>
          <a className="text-body-sm font-medium text-ink underline underline-offset-2 hover:text-charcoal" href={`/tutorials/${topic}.mp4`} download>
            Save video
          </a>
        </div>
      </div>
    </>
  );

  const chip = (extra: string) => (
    <button
      type="button"
      onClick={openPanel}
      aria-label={openLabel}
      aria-expanded="false"
      className={`${dockMotionClass} ${extra} inline-flex items-center gap-2 rounded-btn border border-hairline-strong bg-surface px-3 py-2 text-body-sm font-semibold text-ink transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink`}
      data-hidden={dockHidden}
    >
      <IconPlay size={14} />
      Walkthrough
      <span className="label text-graphite">{formatTime(totalDuration)}</span>
    </button>
  );

  return (
    <div data-tutorial={topic} className="fixed bottom-4 right-4 z-[60] md:bottom-6 md:right-6">
      {!panelVisible &&
        (minimized ? (
          chip("")
        ) : (
          <>
          {/* Phones always get the compact chip so the dock never covers the page. */}
          {chip("sm:hidden")}
          <div className={`${dockMotionClass} relative hidden w-[272px] max-w-[calc(100vw-32px)] overflow-hidden rounded-card border border-hairline-strong bg-surface sm:block`} data-hidden={dockHidden}>
            <button type="button" onClick={openPanel} aria-label={openLabel} aria-expanded="false" className="group block w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
              <div className="relative aspect-video w-full overflow-hidden bg-fog">
                <img
                  src={`/tutorials/${topic}.jpg`}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03] group-focus-visible:scale-[1.03]"
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="flex size-10 items-center justify-center rounded-btn bg-ink text-surface transition-colors group-hover:bg-charcoal group-focus-visible:bg-charcoal">
                    <IconPlay size={18} />
                  </span>
                </div>
              </div>
              <span className="block px-3 py-2.5">
                <span className="block text-body-sm font-semibold text-ink">{tutorial.title}</span>
                <span className="label mt-1 block text-graphite">
                  Walkthrough · {formatTime(totalDuration)} · {chapters.length} steps
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={minimizeDock}
              aria-label="Minimize walkthrough"
              className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-sm border border-hairline-strong bg-surface text-graphite transition-colors hover:border-ink hover:text-ink"
            >
              <IconMinus size={14} />
            </button>
          </div>
          </>
        ))}

      {panelVisible &&
        (isDesktop ? (
          <aside
            ref={setPanelRoot}
            aria-label={`${tutorial.title} expanded walkthrough`}
            data-phase={phase}
            data-visible={phase === "open"}
            className="tutorial-panel fixed inset-y-0 right-0 flex w-[min(720px,46vw)] flex-col border-l border-hairline-strong bg-surface"
          >
            {panelBody}
          </aside>
        ) : (
          <div className="fixed inset-0 flex flex-col justify-end">
            <button type="button" onClick={closePanel} aria-label="Close walkthrough" className="absolute inset-0 bg-ink/40" />
            <div
              ref={setPanelRoot}
              role="dialog"
              aria-modal="true"
              aria-label={`${tutorial.title} expanded walkthrough`}
              data-phase={phase}
              data-visible={phase === "open"}
              className="tutorial-panel relative flex max-h-[92vh] flex-col overflow-hidden rounded-t-[12px] border-t border-hairline-strong bg-surface"
            >
              {panelBody}
            </div>
          </div>
        ))}
    </div>
  );
}
