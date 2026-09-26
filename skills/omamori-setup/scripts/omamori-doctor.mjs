#!/usr/bin/env node
// Omamori setup doctor — read-only, zero dependencies, Node >= 18.
//
// Checks the configured endpoints' /health and detects whether an
// Omamori/omamorisan MCP entry already exists in the config of common MCP
// clients. Never prints a key, header value, or env var value: only
// presence/absence. Exits non-zero (with a "Next step" line) when something
// required is missing.
//
// Usage:
//   node omamori-doctor.mjs [--instance <file>] [--json]

import { readFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REDACTED = "<redacted>";
const HEALTH_TIMEOUT_MS = 4000;

function parseArgs(argv) {
  const args = { instance: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--instance") {
      args.instance = argv[++i];
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

async function fileExists(path) {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    const raw = await readFile(path, "utf8");
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.code === "ENOENT" ? "not_found" : "unreadable" };
  }
}

async function checkHealth(name, baseUrl) {
  const url = `${baseUrl.replace(/\/+$/, "")}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { name, url, ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { name, url, ok: false, error: err.name === "AbortError" ? "timeout" : "unreachable" };
  }
}

// --- Client detection (config presence + redacted auth presence only) ---

function claudeDesktopConfigPath() {
  const home = homedir();
  const p = platform();
  if (p === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (p === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function hasAuthHeader(serverEntry) {
  if (!serverEntry || typeof serverEntry !== "object") return false;
  const asText = JSON.stringify(serverEntry);
  return /authorization/i.test(asText);
}

async function detectClaudeDesktop() {
  const path = claudeDesktopConfigPath();
  if (!(await fileExists(path))) {
    return { client: "claude-desktop", installed: false, configPath: path };
  }
  const { ok, data, error } = await readJson(path);
  if (!ok) {
    return { client: "claude-desktop", installed: true, configPath: path, configReadable: false, error };
  }
  const entry = data?.mcpServers?.omamorisan;
  return {
    client: "claude-desktop",
    installed: true,
    configPath: path,
    configured: Boolean(entry),
    hasAuthHeader: hasAuthHeader(entry),
  };
}

async function detectCursor(cwd) {
  const candidates = [join(homedir(), ".cursor", "mcp.json"), join(cwd, ".cursor", "mcp.json")];
  const results = [];
  for (const path of candidates) {
    if (!(await fileExists(path))) {
      results.push({ path, installed: false });
      continue;
    }
    const { ok, data, error } = await readJson(path);
    if (!ok) {
      results.push({ path, installed: true, configReadable: false, error });
      continue;
    }
    const entry = data?.mcpServers?.omamorisan;
    results.push({
      path,
      installed: true,
      configured: Boolean(entry),
      hasAuthHeader: hasAuthHeader(entry),
    });
  }
  return { client: "cursor", locations: results };
}

async function detectCodex() {
  const path = join(homedir(), ".codex", "config.toml");
  if (!(await fileExists(path))) {
    return { client: "codex", installed: false, configPath: path };
  }
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { client: "codex", installed: true, configPath: path, configReadable: false, error: err.code };
  }
  // Minimal TOML slice: find [mcp_servers.omamorisan] and read its key = value
  // lines until the next [section] or EOF. Good enough for detection only.
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  let found = false;
  let bearerEnvVar = null;
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/);
    if (sectionMatch) {
      inSection = sectionMatch[1].trim() === "omamorisan";
      if (inSection) found = true;
      continue;
    }
    if (line.match(/^\s*\[/)) {
      inSection = false;
      continue;
    }
    if (inSection) {
      const kv = line.match(/^\s*bearer_token_env_var\s*=\s*"([^"]+)"/);
      if (kv) bearerEnvVar = kv[1];
    }
  }
  const envVarSet = bearerEnvVar ? Boolean(process.env[bearerEnvVar]) : null;
  return {
    client: "codex",
    installed: true,
    configPath: path,
    configured: found,
    bearerEnvVarName: bearerEnvVar ? REDACTED_NAME(bearerEnvVar) : null,
    bearerEnvVarSet: envVarSet,
  };
}

// We redact the env var's VALUE always; the var NAME itself isn't a secret
// (it's a config key, e.g. "OMAMORI_AGENT_KEY"), so we keep it for the human
// to cross-check against clients.md, but never print process.env[name].
function REDACTED_NAME(name) {
  return name;
}

async function detectClaudeCode() {
  try {
    const { stdout } = await execFileAsync("claude", ["mcp", "list"], { timeout: 5000 });
    const lines = stdout.split(/\r?\n/).filter((l) => /omamorisan/i.test(l));
    if (lines.length === 0) {
      return { client: "claude-code", installed: true, configured: false };
    }
    const hasAuth = lines.some((l) => /authorization|bearer/i.test(l));
    return { client: "claude-code", installed: true, configured: true, hasAuthHeader: hasAuth };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { client: "claude-code", installed: false };
    }
    return { client: "claude-code", installed: true, error: "cli_error" };
  }
}

// --- Report assembly ---

function printHuman(report) {
  console.log("Omamori setup doctor\n");

  console.log("Endpoints:");
  for (const h of report.health) {
    const line = h.ok ? `  [ok]   ${h.name} (${h.url})` : `  [FAIL] ${h.name} (${h.url}) - ${h.error ?? `status ${h.status}`}`;
    console.log(line);
  }

  console.log("\nMCP clients:");
  const cc = report.clients.claudeCode;
  console.log(`  Claude Code: ${cc.installed ? "installed" : "not found"}${cc.installed ? `, omamorisan ${cc.configured ? "configured" : "not configured"}${cc.configured ? `, auth header ${cc.hasAuthHeader ? "present" : "ABSENT"}` : ""}` : ""}`);

  const cd = report.clients.claudeDesktop;
  console.log(`  Claude Desktop: ${cd.installed ? "config found" : "not found"} (${cd.configPath})${cd.installed && cd.configured !== undefined ? `, omamorisan ${cd.configured ? "configured" : "not configured"}${cd.configured ? `, auth header ${cd.hasAuthHeader ? "present" : "ABSENT"}` : ""}` : ""}`);

  const cur = report.clients.cursor;
  for (const loc of cur.locations) {
    console.log(`  Cursor (${loc.path}): ${loc.installed ? "config found" : "not found"}${loc.installed && loc.configured !== undefined ? `, omamorisan ${loc.configured ? "configured" : "not configured"}${loc.configured ? `, auth header ${loc.hasAuthHeader ? "present" : "ABSENT"}` : ""}` : ""}`);
  }

  const cx = report.clients.codex;
  console.log(`  Codex: ${cx.installed ? "config found" : "not found"} (${cx.configPath})${cx.installed && cx.configured !== undefined ? `, omamorisan ${cx.configured ? "configured" : "not configured"}${cx.configured && cx.bearerEnvVarName ? `, bearer_token_env_var=${cx.bearerEnvVarName} (set: ${cx.bearerEnvVarSet})` : ""}` : ""}`);

  console.log("");
  if (report.nextStep) {
    console.log(`Next step: ${report.nextStep}`);
  } else {
    console.log("All checks passed.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node omamori-doctor.mjs [--instance <file>] [--json]");
    process.exit(0);
  }

  const cwd = process.cwd();
  const defaultInstance = new URL("../assets/instance.example.json", import.meta.url).pathname;
  const instancePath = args.instance ?? defaultInstance;

  const { ok: instanceOk, data: instance, error: instanceError } = await readJson(instancePath);
  if (!instanceOk) {
    const msg = `Could not read instance file at ${instancePath} (${instanceError}).`;
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(msg);
    }
    process.exit(2);
  }

  const services = instance.services ?? {};
  const health = await Promise.all(
    Object.entries(services).map(([name, base]) => checkHealth(name, base))
  );

  const clients = {
    claudeCode: await detectClaudeCode(),
    claudeDesktop: await detectClaudeDesktop(),
    cursor: await detectCursor(cwd),
    codex: await detectCodex(),
  };

  const unhealthy = health.filter((h) => !h.ok);
  const anyClientConfiguredWithAuth =
    (clients.claudeCode.configured && clients.claudeCode.hasAuthHeader) ||
    (clients.claudeDesktop.configured && clients.claudeDesktop.hasAuthHeader) ||
    clients.cursor.locations.some((l) => l.configured && l.hasAuthHeader) ||
    (clients.codex.configured && clients.codex.bearerEnvVarSet);

  let nextStep = null;
  if (unhealthy.length > 0) {
    nextStep = `${unhealthy.map((h) => h.name).join(", ")} failed a health check - verify the URL in ${instancePath} and that the service is up.`;
  } else if (!anyClientConfiguredWithAuth) {
    nextStep =
      "No detected MCP client has an omamorisan entry with an auth header (or, no client installed here). Mint an agent key at <site>/app/settings and follow references/clients.md for your client.";
  }

  const report = { health, clients, nextStep, mcpUrl: instance.mcpUrl ?? null };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  process.exit(nextStep ? 1 : 0);
}

main().catch((err) => {
  console.error("omamori-doctor failed:", err.message);
  process.exit(2);
});
