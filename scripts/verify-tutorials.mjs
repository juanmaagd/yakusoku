import assert from "node:assert/strict";
import { readFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const origin = process.env.TUTORIAL_ORIGIN || "http://localhost:4321";
const work = process.env.TUTORIAL_WORK_DIR || "/private/tmp/omamorisan-tutorials";
const chapters = JSON.parse(await readFile(join(root, "apps/site/public/tutorials/chapters.json"), "utf8"));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
await mkdir(work, { recursive: true });

/** Polls `fn` until it returns truthy or `timeoutMs` elapses. Used for the
 * panel's ~260ms unmount-after-close exit animation instead of asserting the
 * instant after the click. */
async function waitFor(fn, timeoutMs = 1500, intervalMs = 50) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.setDefaultTimeout(7000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  // Two aria-expanded="false" openers exist in the DOM at once (a phone-only
  // chip and the desktop preview card); only one is ever :visible at a given
  // viewport width.
  assert.equal(await page.locator('[data-tutorial="overview"] button[aria-expanded="false"]:visible').count(), 1);
  for (const [topic, chapter] of Object.entries(chapters)) {
    for (const extension of ["mp4", "jpg", "vtt"]) {
      const res = await page.request.get(`${origin}/tutorials/${topic}.${extension}`);
      assert.equal(res.status(), 200, `${topic}.${extension} is served`);
      if (extension === "vtt") assert.ok((await res.text()).startsWith("WEBVTT"));
    }
    const mp4Path = join(root, "apps/site/public/tutorials", `${topic}.mp4`);
    const size = (await stat(mp4Path)).size;
    assert.ok(size <= 6 * 1024 * 1024, `${topic}.mp4 is ${(size / (1024 * 1024)).toFixed(2)}MB, over the 6MB budget`);
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1", mp4Path]);
    const [num, den] = stdout.trim().split("/").map(Number);
    const fps = den ? num / den : num;
    assert.ok(Math.abs(fps - 30) < 0.5, `${topic}.mp4 is ${fps}fps, expected 30`);
    const result = await page.evaluate(async ({ topic, duration }) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = `/tutorials/${topic}.mp4`;
      document.body.append(video);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Video decode timeout")), 15000);
          video.onloadeddata = () => { clearTimeout(timer); resolve(); };
          video.onerror = () => { clearTimeout(timer); reject(new Error(video.error?.message || "Video error")); };
        });
        await video.play();
        video.pause();
        const width = video.videoWidth;
        const height = video.videoHeight;
        const actual = video.duration;
        video.currentTime = Math.max(0, duration - 1);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Video seek timeout")), 15000);
          video.onseeked = () => { clearTimeout(timer); resolve(); };
        });
        return { width, height, duration: actual, lastFrameDecoded: video.readyState >= 2 };
      } finally { video.remove(); }
    }, { topic, duration: chapter.duration });
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.ok(Math.abs(result.duration - chapter.duration) < 0.2);
    assert.equal(result.lastFrameDecoded, true);
    console.log(`${topic}: 1080p/30fps playback, seek, captions, poster and size verified (${result.duration}s, ${(size / (1024 * 1024)).toFixed(2)}MB)`);
  }

  await page.goto(`${origin}/app`);
  const tutorial = page.locator('[data-tutorial="signin"]');
  await tutorial.waitFor();
  await page.getByText("No browser wallet found.", { exact: true }).waitFor();
  // Two aria-expanded="false" openers exist in the DOM at once (a phone-only
  // chip and the desktop preview card, both sharing the same aria-label);
  // :visible narrows to whichever one the current viewport actually shows.
  const compact = tutorial.locator('button[aria-expanded="false"][aria-label="Open Connect your wallet and sign in walkthrough"]:visible');
  assert.ok(await compact.isVisible());
  assert.equal(await tutorial.locator("video").count(), 0, "compact dock does not load video");
  await page.screenshot({ path: join(work, "dock-desktop.png") });
  await compact.click();
  // Desktop: a non-modal <aside>, not the mobile <div role="dialog"> sheet.
  const desktopPanel = tutorial.locator('aside[aria-label$="expanded walkthrough"]');
  await desktopPanel.waitFor();
  assert.ok(await page.locator("body").evaluate((el) => el.classList.contains("tutorial-side-open")));
  assert.ok(await desktopPanel.evaluate((el) => el.getBoundingClientRect().width > 500));
  const video = tutorial.locator("video");
  await video.waitFor();
  assert.equal(await video.getAttribute("autoplay"), null);
  assert.equal(await video.getAttribute("controls"), null, "player must use custom controls, not the native <video controls>");
  assert.equal(await tutorial.locator('input[type="range"][aria-label="Seek"]').count(), 1, "custom seek range is present");
  assert.ok(await tutorial.getByRole("button", { name: /^(Play|Pause)$/ }).count() >= 1, "custom play/pause button is present");
  assert.equal(await tutorial.locator('button[aria-current="step"]').count(), 1);
  await tutorial.getByRole("button", { name: /Use Base Sepolia/ }).click();
  const secondPhaseStart = chapters.signin.chapters[1].start;
  await page.waitForFunction((min) => (document.querySelector('[data-tutorial="signin"] video')?.currentTime ?? 0) >= min, secondPhaseStart);
  assert.equal(await tutorial.getByRole("button", { name: /Use Base Sepolia/ }).getAttribute("aria-current"), "step");
  await page.screenshot({ path: join(work, "panel-desktop.png") });
  await tutorial.getByRole("button", { name: "Close walkthrough" }).click();
  assert.ok(await waitFor(async () => (await tutorial.locator("video").count()) === 0), "video did not unmount after the ~260ms close animation");
  assert.ok(!(await page.locator("body").evaluate((el) => el.classList.contains("tutorial-side-open"))));
  await page.setViewportSize({ width: 390, height: 844 });
  await compact.click();
  // Mobile: the bottom-sheet dialog.
  const mobilePanel = tutorial.locator('div[role="dialog"][aria-label$="expanded walkthrough"]');
  await mobilePanel.waitFor();
  assert.ok(await mobilePanel.evaluate((el) => Math.abs(el.getBoundingClientRect().width - innerWidth) < 2));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(work, "panel-mobile.png") });
  await page.keyboard.press("Escape");
  assert.ok(await waitFor(async () => (await tutorial.locator("video").count()) === 0), "mobile video did not unmount after the ~260ms close animation");
  await page.goto(`${origin}/app/dashboard`);
  await page.locator('[data-tutorial="signin"] button[aria-expanded="false"]:visible').waitFor();
  assert.deepEqual(errors, []);
  console.log("Expandable side player (desktop aside / mobile dialog), custom controls, chapter highlighting, seeking, desktop and mobile layouts verified; no runtime errors.");
} finally { await browser.close(); }
