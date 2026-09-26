// Capture the actual frontend with isolated, explicitly fictional browser fixtures.
// No wallet extension, real key, backend mutation, external API or payment is used.
// PLAYWRIGHT_MODULE may point at an existing playwright package's index.mjs.
//
// Two phases: (1) drive the real app with Playwright and capture a 2x-DPR
// screenshot + target bounding box + click-ness for every named "scene", then
// (2) compose each tutorial's screenshots into an authored, animated 1920x1080
// clip on a second, undistorted (deviceScaleFactor: 1) page driven by a pure
// `window.renderAt(globalSeconds)` function, screenshotted frame-by-frame only
// where something actually moves (see docs/tutorial-videos.md).
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "apps/site/public/tutorials");
const work = process.env.TUTORIAL_WORK_DIR || "/private/tmp/omamorisan-tutorials";
const origin = process.env.TUTORIAL_ORIGIN || "http://localhost:4321";
// Restrict the compose+encode phase to a comma-separated topic subset for cheap
// iteration (e.g. TUTORIAL_TOPICS=approval). Capture always covers every scene
// since scenes are shared across topics. Unset means "all seven", the default.
const onlyTopics = process.env.TUTORIAL_TOPICS ? new Set(process.env.TUTORIAL_TOPICS.split(",")) : null;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const tutorials = JSON.parse(await readFile(join(root, "apps/site/src/lib/tutorials.json"), "utf8"));
await mkdir(out, { recursive: true });
await mkdir(work, { recursive: true });

// --- Design tokens + geometry (DESIGN.md "Gallery Console") -----------------
const OUTPUT_W = 1920;
const OUTPUT_H = 1080;
const CAPTURE_W = 1280; // CSS px of the recorded app viewport
const CAPTURE_H = 800;
const WINDOW_X = 48;
const WINDOW_Y = 136;
const WINDOW_W = 1216;
const WINDOW_H = 760;
const REST_SCALE = WINDOW_W / CAPTURE_W; // 0.95 — whole 1280x800 page fits the window
const FPS = 30;
const HEAD_LEN = 1.6; // camera arrival + caption + spotlight fade-in + cursor glide
const REST_FRAMING = { scale: REST_SCALE, tx: 0, ty: 0 };
const DEFAULT_CURSOR = { x: WINDOW_W * 0.88, y: WINDOW_H * 0.85 }; // lower-right rest position

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: CAPTURE_W, height: CAPTURE_H }, deviceScaleFactor: 2, reducedMotion: "reduce", acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (dialog) => dialog.accept());
const address = "0x1111111111111111111111111111111111111111";
const fakeKey = "DEMO_ONLY_NOT_A_VALID_AGENT_KEY";
const intentId = "intent_walkthrough_example";
const task = "Buy one 1 USDC Amazon gift card";
let hasPromise = false;
let showReceipts = false;
let approval = false;
let paused = false;
const mandate = () => ({ id: intentId, message: { task, budget: "1000000", categories: ["gift_card:amazon"], expiry: String(Math.floor(Date.now()/1000)+3600), nonce: "1" }, signer: address, createdAt: new Date().toISOString(), remainingBudget: "1000000", revoked: false });
const receipt = () => ({ receiptId: "receipt_walkthrough_example", paymentIdentifier: "demo", intentId, createdAt: new Date().toISOString(), state: approval ? "awaiting_world_id" : "jev_refused", verdict: approval ? "ask_human" : "refuse", reasons: [approval ? "Human review required (example)" : "jev: does not match the signed intent"], task, justification: "Example payment request", resourceUrl: "http://localhost:4000/giftcard/steam-1", amount: "1000000", payTo: "0x2222222222222222222222222222222222222222", timeline: [{ stage: "policy", outcome: "pass", ms: 1 }, { stage: "provenance", outcome: "pass", ms: 1 }, { stage: "intercepta", outcome: "pass", ms: 40 }, { stage: "jev", outcome: approval ? "ask_human" : "refuse", reason: "Example intent comparison", ms: 300 }] });

await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.port === "4001" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    const headers = { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
    const respond = (body, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (route.request().method() === "OPTIONS") return respond({});
    if (url.pathname === "/auth/nonce") return respond({ nonce: "walkthrough1234567890", expiresAt: new Date(Date.now()+300000).toISOString() });
    if (url.pathname === "/auth/verify") return respond({ sessionToken: "demo-session", address, expiresAt: new Date(Date.now()+3600000).toISOString() });
    if (url.pathname === "/auth/me") return respond({ address, expiresAt: new Date(Date.now()+3600000).toISOString() });
    if (url.pathname === "/intents") {
      if (route.request().method() === "POST") { hasPromise = true; return respond({ id: intentId, agentKey: fakeKey, remainingBudget: "1000000" }, 201); }
      return respond(hasPromise ? [mandate()] : []);
    }
    if (url.pathname === "/me/pause") { paused = true; return respond({ paused }); }
    if (url.pathname === "/me/resume") { paused = false; return respond({ paused }); }
    if (url.pathname === "/me/control") return respond({ paused });
    if (url.pathname === "/receipts") return respond(showReceipts ? [receipt()] : []);
    if (url.pathname.startsWith("/approvals/")) return respond({ status: "pending", verdict: "ask_human", verificationUri: "https://example.invalid/world-id-demo", userCode: "DEMO-ONLY", expiresAt: new Date(Date.now()+300000).toISOString(), reason: "Simulated approval for tutorial" });
    // /events is served entirely in-page by the addInitScript fetch shim below
    // (never hits the network), so a request landing here would mean the shim
    // didn't match — fail loud instead of silently faking a closed stream.
    return respond({ error: "Unimplemented tutorial fixture" }, 404);
  }
  if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return route.continue();
  return route.abort();
});

await context.addInitScript(({ address }) => {
  let connected = sessionStorage.getItem("demo-connected") === "yes";
  let chain = sessionStorage.getItem("demo-chain") || "0x1";
  window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
    if (method === "eth_accounts") return connected ? [address] : [];
    if (method === "eth_requestAccounts") { connected = true; sessionStorage.setItem("demo-connected", "yes"); return [address]; }
    if (method === "eth_chainId") return chain;
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") { chain = "0x14a34"; sessionStorage.setItem("demo-chain", chain); return null; }
    if (method === "personal_sign" || method === "eth_signTypedData_v4") return "0x" + "11".repeat(65);
    throw new Error("Unexpected tutorial wallet method: " + method);
  } };
}, { address });

// lib/sse.ts drives the Live dashboard from a fetch() stream, not EventSource
// (see that file's header comment). Playwright's route.fulfill() always sends
// a complete, closed response body, so the old ": tutorial fixture\n\n" fixture
// read as an immediate clean end-of-stream: streamSse() returned, the retry
// loop reported "disconnected", and the dashboard showed "Reconnecting..."
// forever. Faking the connection in-page instead — with a ReadableStream that
// enqueues one frame and never closes — keeps the fetch() promise's body open
// for the life of the page, so onOpen() fires once and the status never flips
// back. The frame mirrors the real firewall's first SSE write (an immediate
// "heartbeat" event, apps/firewall/index.ts's GET /events).
await context.addInitScript(() => {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const href = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (href.includes("/events")) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: heartbeat\ndata: \nid: ${crypto.randomUUID()}\n\n`));
          // Never controller.close(): an open stream is what keeps the
          // dashboard's connection status "connected" ("Live") instead of
          // cycling back to "disconnected" every retry interval.
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }
    return realFetch(input, init);
  };
});

const shots = new Map();
/** Screenshots the current page state under `name`, recording the CSS-px
 * viewport-relative bounding box of `target` (if any) and whether it is a
 * clickable control (button/link/select/input) — both consumed by the
 * composition phase's camera framing and click animation. No outline is
 * drawn on the page; the composition draws its own spotlight instead. */
async function capture(name, target) {
  await page.addStyleTag({ content: "[data-tutorial] { display:none!important } * { animation:none!important; transition:none!important }" });
  let box = null;
  let click = false;
  if (target) {
    await target.scrollIntoViewIfNeeded();
    // A block-level target (heading, text node, group container) reports its
    // full container width via getBoundingClientRect(), not the width of what
    // is actually visible — zooming to that would crop chrome at the window's
    // edges instead of framing the content. Prefer the tight union of visible
    // child-element rects, falling back to a text-range union for a leaf text
    // node, and only using the element's own rect when neither exists (an
    // <input>/<select>, already sized to its content).
    box = await target.evaluate((el) => {
      const rects = [];
      for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const r = child.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) rects.push(r);
        } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
          const range = document.createRange();
          range.selectNodeContents(child);
          for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
        }
      }
      if (rects.length === 0) {
        const range = document.createRange();
        range.selectNodeContents(el);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
      }
      if (rects.length === 0) rects.push(el.getBoundingClientRect());
      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      return { x: left, y: top, width: right - left, height: bottom - top };
    });
    click = await target.evaluate((el) => {
      if (["BUTTON", "SELECT", "INPUT"].includes(el.tagName)) return true;
      if (el.tagName === "A" && el.hasAttribute("href")) return true;
      const role = el.getAttribute("role");
      return role === "button" || role === "link";
    });
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(180);
  const file = join(work, `${name}.png`);
  await page.screenshot({ path: file });
  await writeFile(join(work, `${name}.json`), JSON.stringify({ box, click }));
  shots.set(name, { file, box, click });
  console.log(`Captured ${name}`);
}

// --- Pure geometry helpers shared by the compose phase (Node-side precompute) -
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** The camera "framing" for a step: how far to zoom in past REST_SCALE and
 * where to translate so the target (+40 CSS px padding) is centered, clamped
 * so the window never reveals empty space beyond the captured page. */
function computeFraming(box) {
  if (!box) return REST_FRAMING;
  const pad = 40;
  const desiredW = box.width + pad * 2;
  const desiredH = box.height + pad * 2;
  const rawZoom = Math.min(CAPTURE_W / desiredW, CAPTURE_H / desiredH);
  const zoom = clamp(rawZoom, 1.0, 2.2);
  const scale = REST_SCALE * zoom;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const minTx = WINDOW_W - scale * CAPTURE_W;
  const minTy = WINDOW_H - scale * CAPTURE_H;
  const tx = clamp(WINDOW_W / 2 - scale * cx, minTx, 0);
  const ty = clamp(WINDOW_H / 2 - scale * cy, minTy, 0);
  return { scale, tx, ty };
}

/** Where a CSS-px point in the captured page lands in window-space (px inside
 * the 1216x760 product window) once `framing` is applied. */
function toWindowPoint(framing, x, y) {
  return { x: framing.scale * x + framing.tx, y: framing.scale * y + framing.ty };
}

function boxToWindowRect(framing, box, pad) {
  const topLeft = toWindowPoint(framing, box.x - pad, box.y - pad);
  return { x: topLeft.x, y: topLeft.y, w: framing.scale * (box.width + pad * 2), h: framing.scale * (box.height + pad * 2) };
}

/** step duration = ceil(1.6 + max(5.5, words/2.7) + (click ? 0.6 : 0)) sec. */
function stepDuration(step) {
  const words = step.text.split(/\s+/).filter(Boolean).length;
  const reading = Math.max(5.5, words / 2.7);
  return Math.ceil(HEAD_LEN + reading + (step.click ? 0.6 : 0));
}

/** Precomputes every per-step geometry/timing value the composition page
 * needs, so `renderAt(t)` in the browser is pure table lookups + easing. */
function buildStepsData(tutorial) {
  const raw = tutorial.steps.map((s) => {
    const shot = shots.get(s.scene);
    if (!shot) throw new Error(`Missing capture for scene "${s.scene}"`);
    return { scene: s.scene, title: s.title, text: s.text, box: shot.box, click: !!shot.click };
  });
  let prevFraming = REST_FRAMING;
  let cursorPoint = DEFAULT_CURSOR;
  const steps = raw.map((s, i) => {
    const framing = computeFraming(s.box);
    const hasTarget = !!s.box;
    const targetPoint = hasTarget ? toWindowPoint(framing, s.box.x + s.box.width / 2, s.box.y + s.box.height / 2) : null;
    const cursorFrom = cursorPoint;
    if (hasTarget) cursorPoint = targetPoint;
    const nextScene = i < raw.length - 1 ? raw[i + 1].scene : null;
    const sceneChangesNext = nextScene !== null && nextScene !== s.scene;
    const isLast = i === raw.length - 1;
    const duration = stepDuration(s);
    const tailKind = isLast ? "end" : s.click && sceneChangesNext ? "click" : "none";
    const tailLen = tailKind === "end" ? 1.0 : tailKind === "click" ? 0.6 : 0;
    const cameraFrom = prevFraming;
    prevFraming = framing;
    return {
      scene: s.scene,
      displayTitle: s.title.replace(/^\d+\.\s*/, ""),
      title: s.title,
      text: s.text,
      indexLabel: `${String(i + 1).padStart(2, "0")} / ${String(raw.length).padStart(2, "0")}`,
      hasTarget,
      cameraFrom,
      cameraTo: framing,
      cursorFrom,
      cursorTo: targetPoint,
      spotlightRect: hasTarget ? boxToWindowRect(framing, s.box, 8) : null,
      tailKind,
      tailLen,
      isLast,
      duration,
      start: 0, // filled in below once every step's duration is known
    };
  });
  let elapsed = 0;
  for (const s of steps) { s.start = elapsed; elapsed += s.duration; }
  return { steps, totalDuration: elapsed };
}

try {
  if (!process.argv.includes("--render-only")) {
  await page.goto(origin);
  await capture("home", page.getByRole("link", { name: "Launch app", exact: true }).first());
  await capture("setup-claude", page.locator("#setup-heading"));
  await page.goto(`${origin}/app`);
  await page.getByRole("button", { name: "Connect wallet", exact: true }).waitFor();
  await capture("signin", page.getByRole("button", { name: "Connect wallet", exact: true }));
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: /Switch/ }).waitFor();
  await capture("network", page.getByRole("button", { name: /Switch/ }));
  await page.getByRole("button", { name: /Switch/ }).click();
  await page.getByRole("button", { name: "Sign in with wallet", exact: true }).waitFor();
  await capture("sign-message", page.getByRole("button", { name: "Sign in with wallet", exact: true }));
  await page.getByRole("button", { name: "Sign in with wallet", exact: true }).click();
  await page.getByRole("button", { name: "New promise", exact: true }).waitFor();
  await capture("promises", page.getByRole("button", { name: "New promise", exact: true }));
  await page.getByRole("button", { name: "New promise", exact: true }).click();
  await capture("compose-empty", page.locator("#promise-task"));
  await page.locator("#promise-task").fill(task);
  await page.locator("#promise-budget").fill("1");
  await page.getByRole("button", { name: "Amazon gift cards", exact: true }).click();
  await page.getByRole("radio", { name: "1 hour", exact: true }).click();
  await capture("compose-filled", page.locator("#promise-budget"));
  await capture("compose-preview", page.getByRole("button", { name: "Sign promise", exact: true }));
  await page.getByRole("button", { name: "Sign promise", exact: true }).click();
  await page.locator("#mcp-client").waitFor();
  assert.match(await page.locator("#mcp-entry").inputValue(), /\/apps\/mcp\/index\.ts$/);
  await page.locator("#mcp-entry").fill("/Users/you/yakusoku/apps/mcp/index.ts");
  await capture("handoff", page.getByText("Agent key", { exact: true }));
  await capture("connect", page.locator("#mcp-client"));
  await capture("connect-path", page.locator("#mcp-entry"));
  await capture("connect-save", page.getByRole("button", { name: "Download claude_desktop_config.json", exact: true }));
  await capture("connect-desktop", page.getByText("3. Save the configuration in Claude Desktop", { exact: true }));

  // Exercise every configuration download with a fake key, never a real one.
  for (const id of ["claude-desktop", "claude-code", "cursor", "codex", "vscode", "windsurf", "gemini"]) {
    await page.locator("#mcp-client").selectOption(id);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Download / }).click()]);
    const file = join(work, `config-${id}${id === "codex" ? ".toml" : ".json"}`);
    await download.saveAs(file);
    const content = await readFile(file, "utf8");
    if (id === "codex") { assert.match(content, /\[mcp_servers.omamorisan.env\]/); assert.ok(content.includes(fakeKey)); }
    else { const data = JSON.parse(content); const server = (data.servers || data.mcpServers).omamorisan; assert.equal(server.env.OMAMORISAN_AGENT_KEY, fakeKey); assert.equal(server.args[0], "/Users/you/yakusoku/apps/mcp/index.ts"); if (id === "vscode") assert.equal(server.type, "stdio"); }
    if (["cursor", "codex", "vscode"].includes(id)) await capture(`connect-${id}`, page.getByRole("heading", { name: /^3\. Save/ }));
  }
  await page.locator("#mcp-client").selectOption("claude-desktop");
  await capture("connect-verify", page.getByRole("heading", { name: "4. Restart and check the connection", exact: true }));
  await page.getByText("Other MCP clients / connect over HTTP", { exact: true }).click();
  await capture("connect-http", page.getByText("Other MCP clients / connect over HTTP", { exact: true }));
  await page.getByRole("checkbox").check();
  await capture("handoff-done", page.getByRole("button", { name: "Open Live", exact: true }));

  // Mobile layout: no horizontal page overflow in the configuration handoff.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#mcp-client").scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Mobile handoff overflows horizontally");
  await page.setViewportSize({ width: CAPTURE_W, height: CAPTURE_H });
  await page.getByRole("button", { name: "Back to promises", exact: true }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).waitFor();
  await capture("promise-list", page.getByText(task, { exact: true }).first());
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await capture("revoke", page.getByRole("group", { name: /Revoke/ }));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`${origin}/app/dashboard`);
  await page.getByRole("status").filter({ hasText: "Live" }).waitFor();
  await page.getByText("No payments yet.", { exact: true }).waitFor();
  await capture("live", page.getByText("No payments yet.", { exact: true }));
  showReceipts = true;
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Live" }).waitFor();
  await page.getByRole("button").filter({ hasText: "giftcard/steam-1" }).click();
  await capture("live-detail", page.getByRole("button").filter({ hasText: "giftcard/steam-1" }).first());
  await page.getByRole("button", { name: "Pause all", exact: true }).click();
  await capture("pause", page.getByRole("group", { name: "Pause all" }));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  approval = true;
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Live" }).waitFor();
  await page.getByText("DEMO-ONLY", { exact: true }).waitFor();
  await capture("approval", page.getByRole("heading", { name: "Your agent needs you." }));
  assert.deepEqual(errors, [], "Browser runtime errors");

  } else {
    for (const tutorial of Object.values(tutorials)) for (const step of tutorial.steps) {
      if (shots.has(step.scene)) continue;
      const file = join(work, `${step.scene}.png`);
      const meta = JSON.parse(await readFile(join(work, `${step.scene}.json`), "utf8"));
      shots.set(step.scene, { file, ...meta });
    }
  }

  // --- Compose authored, animated 1920x1080 clips -----------------------------
  // A dedicated, undistorted (deviceScaleFactor: 1) context: the composition
  // page needs no wallet/SSE fixtures, only the captured screenshots + fonts.
  const renderContext = await browser.newContext({ viewport: { width: OUTPUT_W, height: OUTPUT_H }, deviceScaleFactor: 1 });
  const framePage = await renderContext.newPage();
  const frameErrors = [];
  framePage.on("pageerror", (e) => frameErrors.push(e.message));

  const fontsDir = join(root, "apps/site/node_modules/@fontsource-variable");
  const monaFont = (await readFile(join(fontsDir, "mona-sans/files/mona-sans-latin-wght-normal.woff2"))).toString("base64");
  const martianFont = (await readFile(join(fontsDir, "martian-mono/files/martian-mono-latin-wght-normal.woff2"))).toString("base64");
  const logoSvg = await readFile(join(root, "apps/site/public/brand/logo.svg"), "utf8");
  const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  // Embedding JSON inside an inline <script>: guard against a literal "</" in
  // any step's copy prematurely closing the tag.
  const safeJson = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");

  function buildCompositionHtml({ title, steps, images, totalDuration }) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family:'Mona Sans Variable'; font-weight:200 900; font-style:normal; src:url(data:font/woff2;base64,${monaFont}) format('woff2-variations'); }
@font-face { font-family:'Martian Mono Variable'; font-weight:200 900; font-style:normal; src:url(data:font/woff2;base64,${martianFont}) format('woff2-variations'); }
:root{ --ink:#0b0d12; --charcoal:#1a1d24; --graphite:#5b606b; --stone:#8a8f99; --canvas:#ffffff; --fog:#f7f8fa; --hairline:#e6e8ec; --hairline-strong:#d5d8de; }
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${OUTPUT_W}px;height:${OUTPUT_H}px;overflow:hidden;background:var(--canvas)}
body{position:relative;font-family:'Mona Sans Variable',ui-sans-serif,system-ui,sans-serif;color:var(--ink)}
.mono{font-family:'Martian Mono Variable',ui-monospace,monospace}
.rail{position:absolute;left:0;top:0;width:${OUTPUT_W}px;height:96px;display:flex;align-items:center;border-bottom:2px solid var(--hairline);background:var(--canvas)}
.rail .logo{margin-left:48px;height:32px;width:auto;display:flex;align-items:center;flex-shrink:0}
.rail .logo svg{height:32px;width:auto;display:block}
.rail .divider{width:2px;height:32px;background:var(--hairline);margin:0 24px;flex-shrink:0}
.rail .title{font-size:30px;font-weight:400;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:820px}
.rail .chip{margin-left:auto;margin-right:48px;font-size:18px;text-transform:uppercase;letter-spacing:0.12em;color:var(--graphite);border:2px solid var(--hairline-strong);border-radius:8px;padding:8px 14px;white-space:nowrap;flex-shrink:0}
.window{position:absolute;left:${WINDOW_X}px;top:${WINDOW_Y}px;width:${WINDOW_W}px;height:${WINDOW_H}px;border:2px solid var(--hairline-strong);border-radius:12px;overflow:hidden;background:var(--canvas)}
.camera{position:absolute;left:0;top:0;width:${CAPTURE_W}px;height:${CAPTURE_H}px;transform-origin:0 0}
.camera img{display:block;width:${CAPTURE_W}px;height:${CAPTURE_H}px}
.spotlight,.cursor{position:absolute;left:0;top:0;pointer-events:none}
.caption{position:absolute;left:1312px;top:${WINDOW_Y}px;width:560px}
.caption .index{font-size:20px;color:var(--graphite);letter-spacing:0.12em}
.caption .title{font-size:46px;font-weight:400;line-height:1.1;letter-spacing:-0.015em;color:var(--ink);margin-top:16px}
.caption .text{font-size:26px;line-height:1.45;color:var(--graphite);margin-top:20px}
.caption .part{will-change:opacity,transform,clip-path}
.rail-progress{position:absolute;left:48px;top:1032px;width:1824px;height:4px;background:var(--hairline-strong)}
.rail-progress .fill{position:absolute;left:0;top:0;height:4px;background:var(--ink)}
.rail-progress .gap{position:absolute;top:0;width:2px;height:4px;background:var(--canvas)}
</style></head><body>
<div class="rail"><span class="logo">${logoSvg}</span><span class="divider"></span><span class="title">${esc(title)}</span><span class="chip mono">Example data · No real payment</span></div>
<div class="window">
  <div class="camera" id="cameraA"><img id="imgA"></div>
  <div class="camera" id="cameraB"><img id="imgB"></div>
  <svg class="spotlight" id="spotlight" width="${WINDOW_W}" height="${WINDOW_H}">
    <defs><mask id="spotMask"><rect width="${WINDOW_W}" height="${WINDOW_H}" fill="#fff"/><rect id="spotHole" rx="10" fill="#000"/></mask></defs>
    <rect id="veil" width="${WINDOW_W}" height="${WINDOW_H}" fill="#ffffff" fill-opacity="0" mask="url(#spotMask)"/>
    <rect id="ring" fill="none" stroke="#0b0d12" stroke-width="3" rx="10" opacity="0"/>
    <circle id="clickRing" fill="none" stroke="#0b0d12" stroke-width="3" r="0" opacity="0"/>
  </svg>
  <svg class="cursor" id="cursor" width="30" height="34" viewBox="0 0 24 28" style="opacity:0">
    <path d="M2 1 L2 22 L8 17.2 L11.6 24.6 L15.2 23 L11.6 15.6 L20 15.6 Z" fill="#0b0d12" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>
</div>
<div class="caption" id="caption">
  <div class="index part mono" id="capIndex"></div>
  <div class="title part" id="capTitle"></div>
  <div class="text part" id="capText"></div>
</div>
<div class="rail-progress" id="progress"><div class="fill" id="progressFill"></div></div>
<script>
window.STEPS = ${safeJson(steps)};
window.TOTAL_DURATION = ${totalDuration};
window.IMAGES = ${safeJson(images)};
(function () {
  const REST = ${safeJson(REST_FRAMING)};
  const WIN_W = ${WINDOW_W}, WIN_H = ${WINDOW_H};

  // Standard CSS cubic-bezier(x1,y1,x2,y2) numeric solve (Newton's method).
  function makeBezier(x1, y1, x2, y2) {
    const A = (a1, a2) => 1 - 3 * a2 + 3 * a1, B = (a1, a2) => 3 * a2 - 6 * a1, C = (a1) => 3 * a1;
    const calc = (t, a1, a2) => ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
    const slope = (t, a1, a2) => 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const s = slope(t, x1, x2);
        if (Math.abs(s) < 1e-6) break;
        t -= (calc(t, x1, x2) - x) / s;
      }
      return calc(t, y1, y2);
    };
  }
  const easeArrive = makeBezier(0.16, 1, 0.3, 1);
  const easeExit = makeBezier(0.7, 0, 0.84, 0);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function arcPoint(a, b, t) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    let px = -dy / dist, py = dx / dist;
    const toCx = WIN_W / 2 - mx, toCy = WIN_H / 2 - my;
    if (px * toCx + py * toCy < 0) { px = -px; py = -py; }
    const offset = Math.min(70, dist * 0.3);
    const cx = mx + px * offset, cy = my + py * offset;
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
  }

  const $ = (id) => document.getElementById(id);
  const cameraA = $("cameraA"), cameraB = $("cameraB"), imgA = $("imgA"), imgB = $("imgB");
  const veil = $("veil"), ring = $("ring"), spotHole = $("spotHole"), clickRing = $("clickRing"), cursor = $("cursor");
  const capIndex = $("capIndex"), capTitle = $("capTitle"), capText = $("capText");
  const progressFill = $("progressFill");

  // Static per-clip elements: phase-boundary gaps in the progress rail.
  const progress = $("progress");
  const trackWidth = 1824;
  for (const step of window.STEPS.slice(1)) {
    const gap = document.createElement("div");
    gap.className = "gap";
    gap.style.left = (trackWidth * step.start / window.TOTAL_DURATION) + "px";
    progress.appendChild(gap);
  }

  let loadedA = "", loadedB = "";
  function setSrc(img, scene, cacheRef) {
    const url = window.IMAGES[scene];
    if (cacheRef.value !== url) { img.src = url; cacheRef.value = url; }
  }
  const refA = { value: "" }, refB = { value: "" };

  function findStepIndex(t) {
    const steps = window.STEPS;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (t < s.start + s.duration || i === steps.length - 1) return i;
    }
    return steps.length - 1;
  }

  function applyCaptionPart(el, text, progress0to1) {
    el.textContent = text;
    const e = easeArrive(progress0to1);
    el.style.opacity = String(e);
    el.style.transform = "translateY(" + (1 - e) * 14 + "px)";
    el.style.clipPath = "inset(" + (1 - e) * 100 + "% 0 0 0)";
  }

  function renderStep(step, i, lt) {
    const steps = window.STEPS;
    const prev = i > 0 ? steps[i - 1] : null;

    // 1. Camera: arrival [0,1.6) from cameraFrom -> cameraTo; the last step's
    // final 1.0s eases back to REST instead ("End").
    let scale, tx, ty;
    if (step.isLast && lt >= step.duration - 1.0) {
      const p = easeArrive(clamp((lt - (step.duration - 1.0)) / 1.0, 0, 1));
      scale = lerp(step.cameraTo.scale, REST.scale, p);
      tx = lerp(step.cameraTo.tx, REST.tx, p);
      ty = lerp(step.cameraTo.ty, REST.ty, p);
    } else {
      const p = easeArrive(clamp(lt / 1.0, 0, 1));
      scale = lerp(step.cameraFrom.scale, step.cameraTo.scale, p);
      tx = lerp(step.cameraFrom.tx, step.cameraTo.tx, p);
      ty = lerp(step.cameraFrom.ty, step.cameraTo.ty, p);
    }
    const transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    cameraA.style.transform = transform;
    cameraB.style.transform = transform;

    // 2. Scene crossfade: 0.45s at the start of a step whose scene differs
    // from the previous one.
    const sceneChanged = prev !== null && prev.scene !== step.scene;
    if (sceneChanged) {
      setSrc(imgA, prev.scene, refA);
      setSrc(imgB, step.scene, refB);
      const p = clamp(lt / 0.45, 0, 1);
      cameraA.style.opacity = String(1 - p);
      cameraB.style.opacity = String(p);
    } else {
      setSrc(imgB, step.scene, refB);
      cameraA.style.opacity = "0";
      cameraB.style.opacity = "1";
    }

    // 3. Caption swap: 0.15s fade-out of the previous caption (skipped on the
    // clip's first step), then index -> title -> text enter staggered 80ms.
    const fadeOutEnd = i === 0 ? 0 : 0.15;
    if (prev !== null && lt < fadeOutEnd) {
      const op = 1 - clamp(lt / 0.15, 0, 1);
      capIndex.textContent = prev.indexLabel; capTitle.textContent = prev.displayTitle; capText.textContent = prev.text;
      for (const el of [capIndex, capTitle, capText]) { el.style.opacity = String(op); el.style.transform = "translateY(0px)"; el.style.clipPath = "inset(0% 0 0 0)"; }
    } else {
      applyCaptionPart(capIndex, step.indexLabel, clamp((lt - fadeOutEnd) / 0.4, 0, 1));
      applyCaptionPart(capTitle, step.displayTitle, clamp((lt - fadeOutEnd - 0.08) / 0.4, 0, 1));
      applyCaptionPart(capText, step.text, clamp((lt - fadeOutEnd - 0.16) / 0.4, 0, 1));
    }

    // 4. Spotlight: fades in [0.9,1.2], stays on, fades out on a click tail or
    // the clip's final "End" tail. Only for steps with a target.
    if (step.hasTarget) {
      let inOp = lt < 0.9 ? 0 : lt < 1.2 ? clamp((lt - 0.9) / 0.3, 0, 1) : 1;
      let outOp = 1;
      if (step.tailKind === "click" && lt >= step.duration - 0.6) outOp = 1 - clamp((lt - (step.duration - 0.6)) / 0.6, 0, 1);
      else if (step.tailKind === "end" && lt >= step.duration - 1.0) outOp = 1 - clamp((lt - (step.duration - 1.0)) / 1.0, 0, 1);
      const op = Math.min(inOp, outOp);
      const r = step.spotlightRect;
      spotHole.setAttribute("x", r.x); spotHole.setAttribute("y", r.y); spotHole.setAttribute("width", r.w); spotHole.setAttribute("height", r.h);
      ring.setAttribute("x", r.x); ring.setAttribute("y", r.y); ring.setAttribute("width", r.w); ring.setAttribute("height", r.h);
      veil.setAttribute("fill-opacity", String(0.55 * op));
      ring.setAttribute("opacity", String(op));
    } else {
      veil.setAttribute("fill-opacity", "0");
      ring.setAttribute("opacity", "0");
    }

    // 5. Cursor: glides along a gentle arc from cursorFrom to the target
    // between 0.9s and 1.6s; a click tail adds a press bump + expanding ring.
    if (step.hasTarget) {
      let point, pressScale = 1;
      if (lt < 0.9) point = step.cursorFrom;
      else if (lt < 1.6) point = arcPoint(step.cursorFrom, step.cursorTo, easeArrive(clamp((lt - 0.9) / 0.7, 0, 1)));
      else point = step.cursorTo;
      if (step.tailKind === "click") {
        const tt = lt - (step.duration - 0.6);
        if (tt >= 0) {
          let press = tt < 0.06 ? tt / 0.06 : tt < 0.12 ? 1 : tt < 0.22 ? 1 - (tt - 0.12) / 0.1 : 0;
          pressScale = 1 - 0.12 * clamp(press, 0, 1);
        }
      }
      cursor.style.opacity = "1";
      cursor.style.transform = "translate(" + (point.x - 3) + "px," + (point.y - 1) + "px) scale(" + pressScale + ")";
      if (step.tailKind === "click") {
        const tt = lt - (step.duration - 0.6);
        if (tt >= 0 && tt <= 0.45) {
          const p = tt / 0.45;
          clickRing.setAttribute("cx", String(step.cursorTo.x)); clickRing.setAttribute("cy", String(step.cursorTo.y));
          clickRing.setAttribute("r", String(36 * p)); clickRing.setAttribute("opacity", String(1 - p));
        } else clickRing.setAttribute("opacity", "0");
      } else clickRing.setAttribute("opacity", "0");
    } else {
      cursor.style.opacity = "0";
      clickRing.setAttribute("opacity", "0");
    }

    // 6. Progress rail fill (the static per-phase gaps are appended once above).
    progressFill.style.width = (trackWidth * clamp((step.start + lt) / window.TOTAL_DURATION, 0, 1)) + "px";
  }

  window.renderAt = function (t) {
    const i = findStepIndex(t);
    const step = window.STEPS[i];
    renderStep(step, i, t - step.start);
  };
})();
</script>
</body></html>`;
  }

  async function ensureFontsReady() {
    await framePage.evaluate(async () => {
      await Promise.all([document.fonts.load('400 40px "Mona Sans Variable"'), document.fonts.load('400 20px "Martian Mono Variable"')]);
      await document.fonts.ready;
    });
    const ok = await framePage.evaluate(() => document.fonts.check('400 40px "Mona Sans Variable"') && document.fonts.check('400 20px "Martian Mono Variable"'));
    assert.ok(ok, "Mona Sans / Martian Mono variable fonts did not load in the composition page");
  }

  function frameTimes(a, b) {
    const count = Math.round((b - a) * FPS);
    const times = [];
    for (let k = 0; k < count; k++) times.push(a + k / FPS);
    return times;
  }

  async function getOldDuration(topic) {
    const file = join(out, `${topic}.mp4`);
    if (!existsSync(file)) return null;
    try {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
      return Math.round(parseFloat(stdout.trim()));
    } catch { return null; }
  }

  let existingManifest = {};
  try { existingManifest = JSON.parse(await readFile(join(out, "chapters.json"), "utf8")); } catch { /* first run */ }
  const manifest = { ...existingManifest };
  const renderReport = [];
  const renderStarted = Date.now();

  for (const [topic, tutorial] of Object.entries(tutorials)) {
    if (onlyTopics && !onlyTopics.has(topic)) continue;
    const oldDuration = await getOldDuration(topic);
    const { steps, totalDuration } = buildStepsData(tutorial);

    const images = {};
    for (const step of steps) {
      if (images[step.scene]) continue;
      const buf = await readFile(shots.get(step.scene).file);
      images[step.scene] = `data:image/png;base64,${buf.toString("base64")}`;
    }

    await framePage.setContent(buildCompositionHtml({ title: tutorial.title, steps, images, totalDuration }));
    await ensureFontsReady();

    async function renderFrame(globalT) {
      await framePage.evaluate((t) => window.renderAt(t), globalT);
      const file = join(work, `${topic}-f${String(frameCounter).padStart(5, "0")}.jpg`);
      frameCounter += 1;
      await framePage.screenshot({ path: file, type: "jpeg", quality: 92 });
      return file;
    }

    let frameCounter = 0;
    const concatEntries = [];
    for (const step of steps) {
      const headLen = Math.min(HEAD_LEN, step.duration);
      for (const lt of frameTimes(0, headLen)) concatEntries.push({ file: await renderFrame(step.start + lt), duration: 1 / FPS });
      const tailStart = step.duration - step.tailLen;
      const holdLen = tailStart - headLen;
      if (holdLen > 0) concatEntries.push({ file: await renderFrame(step.start + headLen), duration: holdLen });
      if (step.tailLen > 0) for (const lt of frameTimes(tailStart, step.duration)) concatEntries.push({ file: await renderFrame(step.start + lt), duration: 1 / FPS });
    }

    // Poster: step 1, global t=1.7s — camera settled (arrival ends at 1.0s),
    // spotlight fully on (fade-in ends at 1.2s).
    await framePage.evaluate((t) => window.renderAt(t), 1.7);
    await framePage.screenshot({ path: join(out, `${topic}.jpg`), type: "jpeg", quality: 85 });

    const concatLines = concatEntries.map((e) => `file '${e.file}'\nduration ${e.duration}`);
    concatLines.push(`file '${concatEntries[concatEntries.length - 1].file}'`); // concat quirk: repeat the last entry so its duration isn't dropped
    const list = join(work, `${topic}.txt`);
    await writeFile(list, concatLines.join("\n"));

    const vtt = ["WEBVTT", ""];
    const stamp = (seconds) => new Date(seconds * 1000).toISOString().slice(11, 23);
    const chapters = steps.map((s) => ({ title: s.title, start: s.start, duration: s.duration }));
    for (const s of steps) vtt.push(`${stamp(s.start)} --> ${stamp(s.start + s.duration)}\n${s.title}\n${s.text}\n`);
    await writeFile(join(out, `${topic}.vtt`), vtt.join("\n"));
    manifest[topic] = { duration: totalDuration, chapters };

    // Encode; nudge CRF up if the clip lands over the 5MB target.
    const mp4 = join(out, `${topic}.mp4`);
    let crf = 20;
    let size = Infinity;
    let usedCrf = crf;
    for (let attempt = 0; attempt < 4; attempt++) {
      usedCrf = crf;
      await new Promise((accept, reject) => {
        const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-t", String(totalDuration), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-movflags", "+faststart", mp4], { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? accept() : reject(new Error(`ffmpeg exited ${code}`))));
      });
      size = (await stat(mp4)).size;
      if (size <= 5 * 1024 * 1024) break;
      crf += 3;
    }
    renderReport.push({ topic, oldDuration, newDuration: totalDuration, sizeMb: (size / (1024 * 1024)).toFixed(2), crf: usedCrf });
    console.log(`Rendered ${topic}: ${oldDuration ?? "?"}s -> ${totalDuration}s, ${(size / (1024 * 1024)).toFixed(2)}MB (crf ${usedCrf})`);
  }

  await writeFile(join(out, "chapters.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(root, "apps/site/src/lib/tutorial-chapters.json"), JSON.stringify(manifest, null, 2) + "\n");
  // Full transcript regenerates every run (text-only, independent of TUTORIAL_TOPICS).
  await writeFile(join(out, "transcript.txt"), Object.values(tutorials).map((t) => `${t.title}\n\n${t.steps.map((s) => `${s.title}\n${s.text}`).join("\n\n")}`).join("\n\n---\n\n"));

  assert.deepEqual(frameErrors, [], "Composition page runtime errors");
  await browser.close();

  console.log(`Render phase: ${((Date.now() - renderStarted) / 1000).toFixed(1)}s`);
  console.table(renderReport);
  console.log(process.argv.includes("--render-only") ? "Rendered from previously verified browser captures." : "All seven client downloads validated; mobile layout and browser runtime checks passed.");
} catch (error) {
  if (browser.isConnected()) {
    await page.screenshot({ path: join(work, "failure.png") }).catch(() => {});
    console.error("Browser errors:", errors);
  }
  throw error;
} finally {
  await browser.close();
}
