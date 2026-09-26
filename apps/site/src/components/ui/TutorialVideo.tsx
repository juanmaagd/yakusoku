import { useEffect, useMemo, useRef, useState } from "react";
import tutorials from "../../lib/tutorials.json";

export type TutorialTopic = keyof typeof tutorials;

type Chapter = { start: number; duration: number; title: string; text: string };

function chaptersFor(topic: TutorialTopic): Chapter[] {
  let start = 0;
  return tutorials[topic].steps.map((step) => {
    // The recorder uses the same duration rule when it renders frames and WebVTT.
    const duration = Math.max(13, Math.ceil(step.text.split(/\s+/).length / 2.4));
    const chapter = { start, duration, title: step.title, text: step.text };
    start += duration;
    return chapter;
  });
}

/** A small persistent dock that opens into a large panel beside the live UI. */
export default function TutorialVideo({ topic }: { topic: TutorialTopic }) {
  const tutorial = tutorials[topic];
  const chapters = useMemo(() => chaptersFor(topic), [topic]);
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(0);
  const player = useRef<HTMLVideoElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const activeItem = useRef<HTMLLIElement>(null);
  const activeIndex = Math.max(0, chapters.findIndex((chapter, i) => time < chapter.start + chapter.duration || i === chapters.length - 1));

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("tutorial-side-open");
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("tutorial-side-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) activeItem.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function seek(index: number) {
    const video = player.current;
    if (!video) return;
    video.currentTime = chapters[index]!.start;
    setTime(chapters[index]!.start);
    void video.play().catch(() => {});
  }

  return <aside data-tutorial={topic} aria-label={`${tutorial.title} video help`} className="fixed bottom-4 right-4 z-[60] md:bottom-6 md:right-6">
    {!open ? (
      <button type="button" onClick={() => setOpen(true)} aria-label={`Open ${tutorial.title} walkthrough`} aria-expanded="false" className="group block w-[min(240px,calc(100vw-32px))] overflow-hidden rounded-card border border-hairline-strong bg-surface text-left shadow-console transition-[width,box-shadow] hover:border-ink hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
        <img src={`/tutorials/${topic}.jpg`} alt="" loading="lazy" className="aspect-video w-full bg-fog object-contain" />
        <span className="block px-3 py-2.5">
          <span className="block text-caption font-semibold text-ink">Watch: {tutorial.title}</span>
          <span className="mt-0.5 block text-caption text-graphite">Click to enlarge · {chapters.length} phases</span>
        </span>
      </button>
    ) : (
      <div className="fixed inset-y-0 right-0 flex w-full flex-col border-l border-hairline-strong bg-surface shadow-console lg:w-[min(700px,48vw)]" aria-label={`${tutorial.title} expanded walkthrough`}>
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-4 py-3 md:px-5">
          <div className="min-w-0">
            <p className="text-caption font-semibold uppercase tracking-wide text-graphite">Page walkthrough · Phase {activeIndex + 1} of {chapters.length}</p>
            <h2 className="mt-1 text-subheading font-medium text-ink">{tutorial.title}</h2>
          </div>
          <button ref={closeButton} type="button" onClick={() => setOpen(false)} aria-label="Close walkthrough" className="shrink-0 rounded-btn border border-hairline-strong px-3 py-1.5 text-body-sm hover:border-ink">Close</button>
        </div>
        <div className="shrink-0 border-b border-hairline bg-fog p-3 md:p-4">
          <video ref={player} controls playsInline preload="metadata" poster={`/tutorials/${topic}.jpg`} aria-label={tutorial.title} onLoadedMetadata={() => { if (player.current && time > 0) player.current.currentTime = time; }} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onSeeked={(event) => setTime(event.currentTarget.currentTime)} className="aspect-video w-full rounded-btn bg-ink object-contain">
            <source src={`/tutorials/${topic}.mp4`} type="video/mp4" />
            <track kind="captions" src={`/tutorials/${topic}.vtt`} srcLang="en" label="English" />
            <a href={`/tutorials/${topic}.mp4`}>Download the walkthrough</a>
          </video>
          <div className="mt-2 flex items-center justify-between gap-3 text-caption text-graphite">
            <span>Example data · No real payment · Captioned</span>
            <button type="button" onClick={() => { const video = player.current; if (video) void video.requestFullscreen().catch(() => {}); }} className="shrink-0 font-medium text-ink underline underline-offset-2">Fill screen</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 md:px-5" aria-label="Video phases">
          <p className="text-body-sm text-graphite">The highlighted phase follows the video. Choose any phase to replay it while keeping the app visible beside this panel.</p>
          <ol className="mt-4 space-y-2">
            {chapters.map((chapter, index) => <li key={chapter.title} ref={index === activeIndex ? activeItem : undefined}>
              <button type="button" aria-current={index === activeIndex ? "step" : undefined} onClick={() => seek(index)} className={`w-full rounded-card border p-3 text-left transition-colors ${index === activeIndex ? "border-[#396cec] bg-[#edf3ff] ring-2 ring-[#396cec]/30" : "border-hairline bg-surface hover:border-ink hover:bg-fog"}`}>
                <span className="flex items-center gap-3">
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-caption ${index === activeIndex ? "bg-[#396cec] text-white" : "bg-fog text-graphite"}`}>{index + 1}</span>
                  <span className="text-body-sm font-semibold text-ink">{chapter.title.replace(/^\d+\.\s*/, "")}</span>
                  <span className="ml-auto font-mono text-caption text-graphite">{Math.floor(chapter.start / 60)}:{String(chapter.start % 60).padStart(2, "0")}</span>
                </span>
                <span className="mt-2 block pl-10 text-body-sm text-graphite">{chapter.text}</span>
              </button>
            </li>)}
          </ol>
          <a className="mt-5 inline-block text-body-sm font-medium underline underline-offset-2" href={`/tutorials/${topic}.mp4`} download>Save this video</a>
        </div>
      </div>
    )}
  </aside>;
}
