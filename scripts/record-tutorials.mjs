// Capture the actual frontend with isolated, explicitly fictional browser fixtures.
// No wallet extension, real key, backend mutation, external API or payment is used.
// PLAYWRIGHT_MODULE may point at an existing playwright package's index.mjs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "apps/site/public/tutorials");
const work = process.env.TUTORIAL_WORK_DIR || "/private/tmp/omamorisan-tutorials";
const origin = process.env.TUTORIAL_ORIGIN || "http://localhost:4321";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const tutorials = JSON.parse(await readFile(join(root, "apps/site/src/lib/tutorials.json"), "utf8"));
await mkdir(out, { recursive: true });
await mkdir(work, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: "reduce", acceptDownloads: true });
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
    if (url.pathname.includes("events")) return route.fulfill({ headers, contentType: "text/event-stream", body: ": tutorial fixture\n\n" });
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

const shots = new Map();
async function capture(name, target) {
  await page.addStyleTag({ content: "[data-tutorial] { display:none!important } * { animation:none!important; transition:none!important }" });
  await page.evaluate(() => { document.querySelectorAll("[data-highlight]").forEach((e) => { e.style.outline = ""; e.removeAttribute("data-highlight"); }); });
  if (target) {
    await target.scrollIntoViewIfNeeded();
    await target.evaluate((el) => { el.style.outline = "3px solid #396cec"; el.style.outlineOffset = "6px"; el.setAttribute("data-highlight", "true"); });
  } else await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(180);
  const file = join(work, `${name}.png`);
  await page.screenshot({ path: file });
  shots.set(name, file);
  console.log(`Captured ${name}`);
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
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Back to promises", exact: true }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).waitFor();
  await capture("promise-list", page.getByText(task, { exact: true }).first());
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await capture("revoke", page.getByRole("group", { name: /Revoke/ }));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`${origin}/app/dashboard`);
  await page.getByText("No payments yet.", { exact: true }).waitFor();
  await capture("live", page.getByText("No payments yet.", { exact: true }));
  showReceipts = true;
  await page.reload();
  await page.getByRole("button").filter({ hasText: "giftcard/steam-1" }).click();
  await capture("live-detail", page.getByRole("button").filter({ hasText: "giftcard/steam-1" }).first());
  await page.getByRole("button", { name: "Pause all", exact: true }).click();
  await capture("pause", page.getByRole("group", { name: "Pause all" }));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  approval = true;
  await page.reload();
  await page.getByText("DEMO-ONLY", { exact: true }).waitFor();
  await capture("approval", page.getByRole("heading", { name: "Your agent needs you." }));
  assert.deepEqual(errors, [], "Browser runtime errors");

  } else {
    for (const tutorial of Object.values(tutorials)) for (const step of tutorial.steps) shots.set(step.scene, join(work, `${step.scene}.png`));
  }

  // Compose readable video frames around real screenshots with a persistent demo label.
  const framePage = await context.newPage();
  await framePage.setViewportSize({ width: 1920, height: 1080 });
  const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const stamp = (seconds) => new Date(seconds * 1000).toISOString().slice(11, 23);
  const manifest = {};
  const jobs = [];
  for (const [topic, tutorial] of Object.entries(tutorials)) {
    const concat = [];
    const vtt = ["WEBVTT", ""];
    let elapsed = 0;
    const chapters = [];
    for (const [i, step] of tutorial.steps.entries()) {
      const screenshot = await readFile(shots.get(step.scene));
      const image = `data:image/png;base64,${screenshot.toString("base64")}`;
      const duration = Math.max(13, Math.ceil(step.text.split(/\s+/).length / 2.4));
      await framePage.setContent(`<!doctype html><html><head><style>
        *{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#15181e;font-family:Arial,sans-serif}
        header{height:118px;display:flex;align-items:center;justify-content:space-between;padding:0 64px;border-bottom:1px solid #d8dce3;background:white}
        .brand{font-size:32px;font-weight:700;letter-spacing:-1px}.demo{font-size:21px;letter-spacing:1px;color:#58677b}
        main{display:grid;grid-template-columns:1240px 1fr;gap:46px;padding:54px 54px 0}
        .screen{border:1px solid #d5d9e1;border-radius:14px;overflow:hidden;background:white;box-shadow:0 8px 30px #0000000b}
        .browser{padding:15px 22px;background:#fff;border-bottom:1px solid #e0e4eb;font:19px monospace;color:#677184}
        img{display:block;width:1238px;height:auto}.topic{font-size:19px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#58677b;line-height:1.6}
        h1{font-size:40px;line-height:1.13;letter-spacing:-1px;margin:24px 0}p{font-size:27px;line-height:1.5;margin:0;color:#394354}
        footer{position:absolute;bottom:34px;left:64px;right:64px;display:flex;justify-content:space-between;font-size:19px;color:#677184}.progress{height:5px;background:#15181e;position:absolute;bottom:0;left:0;width:${100*(i+1)/tutorial.steps.length}%}
        </style></head><body><header><div class="brand">Omamorisan · Walkthrough</div><div class="demo">EXAMPLE DATA · NO REAL PAYMENT</div></header><main><div class="screen"><div class="browser">${step.scene === "home" ? "/" : ["live", "live-detail", "pause", "approval"].includes(step.scene) ? "/app/dashboard" : "/app"} &nbsp; · &nbsp; Local demo</div><img src="${image}"></div><section><div class="topic">${esc(tutorial.title)}</div><h1>${esc(step.title)}</h1><p>${esc(step.text)}</p></section></main><footer><span>Pause to follow along. Blue outline marks the control to use.</span><span>Step ${i+1} / ${tutorial.steps.length}</span></footer><div class="progress"></div></body></html>`);
      await framePage.locator("img").evaluate((img) => img.decode());
      assert.ok(await framePage.locator("main section p").evaluate((el) => el.getBoundingClientRect().bottom < 1000), `Caption overflow: ${topic}/${i}`);
      const frame = join(work, `${topic}-${i}.png`);
      await framePage.screenshot({ path: frame });
      if (i === 0) await framePage.screenshot({ path: join(out, `${topic}.jpg`), type: "jpeg", quality: 85 });
      concat.push(`file '${frame}'\nduration ${duration}`);
      vtt.push(`${stamp(elapsed)} --> ${stamp(elapsed+duration)}\n${step.title}\n${step.text}\n`);
      chapters.push({ title: step.title, start: elapsed, duration });
      elapsed += duration;
    }
    concat.push(`file '${join(work, `${topic}-${tutorial.steps.length-1}.png`)}'`);
    const list = join(work, `${topic}.txt`);
    await writeFile(list, concat.join("\n"));
    await writeFile(join(out, `${topic}.vtt`), vtt.join("\n"));
    jobs.push({ topic, list, elapsed });
    manifest[topic] = { duration: elapsed, chapters };
  }
  await writeFile(join(out, "chapters.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(out, "transcript.txt"), Object.values(tutorials).map((t) => `${t.title}\n\n${t.steps.map((s) => `${s.title}\n${s.text}`).join("\n\n")}`).join("\n\n---\n\n"));
  await browser.close();
  for (const { topic, list, elapsed } of jobs) {
    await new Promise((accept, reject) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-t", String(elapsed), "-vf", "fps=10,format=yuv420p", "-c:v", "libx264", "-preset", "fast", "-tune", "stillimage", "-crf", "25", "-movflags", "+faststart", join(out, `${topic}.mp4`)], { stdio: "inherit" });
      child.on("error", reject); child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`ffmpeg exited ${code}`)));
    });
    console.log(`Rendered ${topic}: ${elapsed}s`);
  }
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
