#!/usr/bin/env node
// Regenerates ../references/tools.md from the Omamori MCP server's own
// `tools/list` (Streamable HTTP, MCP spec 2025-06-18) — the single source of
// truth for tool names/descriptions/schemas, so this reference can never
// hand-copy-drift from apps/mcp/tools.ts (owned by another session). Falls
// back to a best-effort static parse of apps/mcp/tools.ts if the live server
// can't be reached or ever starts requiring auth for listing (it doesn't
// today — only account-scoped tools like pay_x402 need a credential).
//
// Node >= 18 (global fetch), zero dependencies.
// Usage: node sync-tool-reference.mjs [--mcp <url>] [--out <path>] [--tools-ts <path>]

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_MCP_URL = "https://omamorisan-mcp-8e4dca-91-98-199-240.sslip.io/mcp";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "references", "tools.md");
const DEFAULT_TOOLS_TS = join(HERE, "..", "..", "..", "apps", "mcp", "tools.ts");
const REQUEST_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const args = { mcp: DEFAULT_MCP_URL, out: DEFAULT_OUT, toolsTs: DEFAULT_TOOLS_TS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mcp") args.mcp = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--tools-ts") args.toolsTs = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

// --- Minimal Streamable HTTP MCP client --------------------------------------

/** The live team instance answers every call as `text/event-stream`
 * ("event: message\ndata: {...json...}\n\n") even though `Accept` also
 * offers `application/json` — this handles either shape. */
function extractJsonRpcPayload(contentType, text) {
  if (contentType.includes("application/json")) return JSON.parse(text);
  const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) throw new Error(`no SSE data line in response: ${text.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1].slice("data:".length).trim());
}

async function rpcCall(mcpUrl, sessionId, body, { expectBody = true } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const nextSessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!expectBody) return { sessionId: nextSessionId, payload: undefined };
  const contentType = res.headers.get("content-type") ?? "";
  const payload = extractJsonRpcPayload(contentType, text);
  if (payload.error) throw new Error(`JSON-RPC error ${payload.error.code}: ${payload.error.message}`);
  return { sessionId: nextSessionId, payload };
}

/** initialize -> notifications/initialized -> tools/list, in that order (MCP
 * spec's required handshake). No Authorization header is sent — listing
 * tool metadata needs none on this server. */
async function fetchLiveTools(mcpUrl) {
  const init = await rpcCall(mcpUrl, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "omamori-purchase-sync", version: "1.0" } },
  });
  const sessionId = init.sessionId;
  await rpcCall(mcpUrl, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }, { expectBody: false });
  const list = await rpcCall(mcpUrl, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = list.payload?.result?.tools;
  if (!Array.isArray(tools)) throw new Error("tools/list response had no tools array");
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    params: jsonSchemaToParams(t.inputSchema ?? {}),
  }));
}

function jsonSchemaType(def) {
  if (!def || typeof def !== "object") return "unknown";
  if (def.type === "array") return `array<${jsonSchemaType(def.items ?? {})}>`;
  return def.type ?? "unknown";
}

function jsonSchemaToParams(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: jsonSchemaType(def),
    required: required.has(name),
    description: def?.description ?? "",
  }));
}

// --- Fallback: best-effort static parse of apps/mcp/tools.ts -----------------
//
// Tailored to this file's consistent style (server.registerTool("name", {
// description: "..." + "..." , inputSchema: { key: z.foo()...describe("...") }
// }, async (...) => {...})) rather than a general TS/zod parser. Only used
// when the live server can't be reached or ever starts requiring auth.

function skipStringLiteral(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === "\\") i++;
    i++;
  }
  return i + 1;
}

/** Drops line and block comments while copying string/template literals
 * through verbatim (so a quote INSIDE a comment — e.g. tools.ts's own
 * `check_approval` handler has a line comment quoting "forbidden" and
 * "approval_not_found" — never gets mistaken for the start of a real string
 * literal by the balance-tracking below). Must run once over the whole file
 * before any other parsing here. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipStringLiteral(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Balanced-bracket extraction starting AT the opening character; returns the
 * substring including both brackets and the index just past the close. */
function extractBalanced(text, openIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipStringLiteral(text, i) - 1;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return { content: text.slice(openIdx, i + 1), endIdx: i + 1 };
    }
  }
  throw new Error(`unbalanced ${openChar}${closeChar} starting at ${openIdx}`);
}

/** Reads a run of `"..." + "..." + ...` starting at `startIdx`, decoding JS
 * escapes properly (via JSON.parse, since this codebase only uses
 * double-quoted string literals for descriptions). */
function readStringConcat(text, startIdx) {
  let i = startIdx;
  let result = "";
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '"') break;
    const end = skipStringLiteral(text, i);
    result += JSON.parse(text.slice(i, end));
    i = end;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === "+") {
      i++;
      continue;
    }
    break;
  }
  return { value: result, endIdx: i };
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipStringLiteral(text, i) - 1;
      continue;
    }
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function extractParamDescription(value) {
  const idx = value.indexOf(".describe(");
  if (idx === -1) return "";
  const openParenIdx = idx + ".describe(".length - 1;
  const { content } = extractBalanced(value, openParenIdx, "(", ")");
  return readStringConcat(content, 1).value;
}

function extractZodType(value) {
  // `z` and its first method may be split across lines (e.g. `z\n  .string()`).
  const m = value.trim().match(/^z\s*\.\s*(\w+)\s*\(/);
  if (!m) return "unknown";
  if (m[1] === "string") return "string";
  if (m[1] === "number") return "number";
  if (m[1] === "boolean") return "boolean";
  if (m[1] === "object") return "object";
  if (m[1] === "array") {
    const innerStart = value.indexOf("(") + 1;
    const { content } = extractBalanced(value, value.indexOf("("), "(", ")");
    return `array<${extractZodType(content.slice(1, -1))}>`;
  }
  return m[1];
}

function parseInputSchemaObject(objText) {
  const inner = objText.slice(1, -1); // strip outer { }
  return splitTopLevel(inner).map((pair) => {
    const colonIdx = pair.indexOf(":");
    const name = pair.slice(0, colonIdx).trim();
    const value = pair.slice(colonIdx + 1).trim();
    return {
      name,
      type: extractZodType(value),
      required: !/\.optional\(\)/.test(value),
      description: extractParamDescription(value),
    };
  });
}

async function parseToolsFileFallback(toolsTsPath) {
  const raw = await readFile(toolsTsPath, "utf8");
  const src = stripComments(raw);
  const tools = [];
  const registerRe = /server\.registerTool\(\s*"([a-zA-Z0-9_]+)"/g;
  let match;
  while ((match = registerRe.exec(src))) {
    const name = match[1];
    const callOpenParen = src.indexOf("(", match.index + "server.registerTool".length);
    const { content: callBlock } = extractBalanced(src, callOpenParen, "(", ")");

    const descIdx = callBlock.indexOf("description:");
    const description = descIdx === -1 ? "" : readStringConcat(callBlock, descIdx + "description:".length).value;

    const schemaIdx = callBlock.indexOf("inputSchema:");
    let params = [];
    if (schemaIdx !== -1) {
      const braceIdx = callBlock.indexOf("{", schemaIdx);
      const { content: schemaObj } = extractBalanced(callBlock, braceIdx, "{", "}");
      params = parseInputSchemaObject(schemaObj);
    }
    tools.push({ name, description, params });
  }
  if (tools.length === 0) throw new Error(`found no server.registerTool(...) calls in ${toolsTsPath}`);
  return tools;
}

// --- Rendering -----------------------------------------------------------------

function escapeCell(text) {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderToolsMarkdown(tools, sourceNote) {
  const lines = [
    "<!-- generated — do not edit; run `node scripts/sync-tool-reference.mjs` to refresh -->",
    "",
    "# Omamori MCP tool reference",
    "",
    sourceNote,
    "",
    `${tools.length} tools.`,
    "",
  ];
  for (const tool of tools) {
    lines.push(`## \`${tool.name}\``, "", tool.description || "_(no description)_", "");
    if (tool.params.length === 0) {
      lines.push("_(no parameters)_");
    } else {
      lines.push("| Param | Type | Required | Description |", "|---|---|---|---|");
      for (const p of tool.params) {
        lines.push(`| \`${p.name}\` | ${p.type} | ${p.required ? "yes" : "no"} | ${escapeCell(p.description)} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// --- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node sync-tool-reference.mjs [--mcp <url>] [--out <path>] [--tools-ts <path>]");
    return;
  }

  let tools;
  let sourceNote;
  try {
    tools = await fetchLiveTools(args.mcp);
    sourceNote = `Source: live \`tools/list\` from \`${args.mcp}\` (no auth needed for listing).`;
    console.error(`[sync-tool-reference] fetched ${tools.length} tools live from ${args.mcp}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync-tool-reference] live tools/list failed (${message}) — falling back to a static parse of ${args.toolsTs}`);
    tools = await parseToolsFileFallback(args.toolsTs);
    sourceNote =
      `Source: static parse of \`apps/mcp/tools.ts\` (fallback — the live MCP server at \`${args.mcp}\` could not be ` +
      `reached or required auth for listing; run this script again once it's reachable for the authoritative version).`;
  }

  const markdown = renderToolsMarkdown(tools, sourceNote);
  await writeFile(args.out, markdown, "utf8");
  console.error(`[sync-tool-reference] wrote ${args.out} (${tools.length} tools)`);
}

main().catch((err) => {
  console.error(`[sync-tool-reference] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
