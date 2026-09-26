import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const origin = process.env.TUTORIAL_ORIGIN || "http://localhost:4321";
const work = process.env.TUTORIAL_WORK_DIR || "/private/tmp/omamorisan-tutorials";
const chapters = JSON.parse(await readFile(join(root, "apps/site/public/tutorials/chapters.json"), "utf8"));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
await mkdir(work, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.setDefaultTimeout(7000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  assert.equal(await page.locator('[data-tutorial="overview"] button[aria-expanded="false"]').count(), 1);
  for (const [topic, chapter] of Object.entries(chapters)) {
    for (const extension of ["mp4", "jpg", "vtt"]) {
      const res = await page.request.get(`${origin}/tutorials/${topic}.${extension}`);
      assert.equal(res.status(), 200, `${topic}.${extension} is served`);
      if (extension === "vtt") assert.ok((await res.text()).startsWith("WEBVTT"));
    }
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
    console.log(`${topic}: 1080p playback, seek, captions and poster verified (${result.duration}s)`);
  }
  await page.goto(`${origin}/app`);
  const tutorial = page.locator('[data-tutorial="signin"]');
  await tutorial.waitFor();
  await page.getByText("No browser wallet found.", { exact: true }).waitFor();
  const compact = tutorial.getByRole("button", { name: /Open Connect your wallet and sign in walkthrough/ });
  assert.ok(await compact.isVisible());
  assert.equal(await tutorial.locator("video").count(), 0, "compact dock does not load video");
  await page.screenshot({ path: join(work, "dock-desktop.png") });
  await compact.click();
  const panel = tutorial.locator('div[aria-label$="expanded walkthrough"]');
  await panel.waitFor();
  assert.ok(await page.locator("body").evaluate((el) => el.classList.contains("tutorial-side-open")));
  assert.ok(await panel.evaluate((el) => el.getBoundingClientRect().width > 500));
  const video = tutorial.locator("video");
  await video.waitFor();
  assert.equal(await video.getAttribute("autoplay"), null);
  assert.equal(await tutorial.locator('button[aria-current="step"]').count(), 1);
  await tutorial.getByRole("button", { name: /Use Base Sepolia/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-tutorial="signin"] video')?.currentTime >= 13);
  assert.equal(await tutorial.getByRole("button", { name: /Use Base Sepolia/ }).getAttribute("aria-current"), "step");
  await page.screenshot({ path: join(work, "panel-desktop.png") });
  await tutorial.getByRole("button", { name: "Close walkthrough" }).click();
  assert.equal(await tutorial.locator("video").count(), 0);
  assert.ok(!(await page.locator("body").evaluate((el) => el.classList.contains("tutorial-side-open"))));
  await page.setViewportSize({ width: 390, height: 844 });
  await compact.click();
  assert.ok(await panel.evaluate((el) => Math.abs(el.getBoundingClientRect().width - innerWidth) < 2));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(work, "panel-mobile.png") });
  await page.keyboard.press("Escape");
  assert.equal(await tutorial.locator("video").count(), 0);
  await page.goto(`${origin}/app/dashboard`);
  await page.locator('[data-tutorial="signin"] button[aria-expanded="false"]').waitFor();
  assert.deepEqual(errors, []);
  console.log("Expandable side player, chapter highlighting, seeking, desktop and mobile layouts verified; no runtime errors.");
} finally { await browser.close(); }
