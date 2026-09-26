import { SITE } from "../config";

export const MCP_CLIENTS = [
  { id: "claude-desktop", name: "Claude Desktop", file: "claude_desktop_config.json", destination: "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json · Windows: %APPDATA%\\Claude\\claude_desktop_config.json", open: "Open Claude Desktop → Settings → Developer → Edit Config. This opens the configuration file on your computer.", finish: "Fully quit and reopen Claude Desktop. Look for omamorisan in its available tools.", docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers" },
  { id: "claude-code", name: "Claude Code", file: ".mcp.json", destination: ".mcp.json in the folder where you run Claude Code", open: "Open your project folder in an editor. Create .mcp.json at the top level, beside package.json.", finish: "Run claude in that folder, approve the project MCP server, then use /mcp to check omamorisan.", docs: "https://code.claude.com/docs/en/mcp" },
  { id: "cursor", name: "Cursor", file: "mcp.json", destination: "~/.cursor/mcp.json (personal configuration)", open: "Open Cursor Settings → Tools & MCP. Open the MCP configuration, or open the .cursor folder in your home directory and edit mcp.json.", finish: "Reload Cursor and enable omamorisan under Tools & MCP. Use Agent mode.", docs: "https://cursor.com/docs/context/mcp" },
  { id: "codex", name: "Codex", file: "omamorisan.toml", destination: "~/.codex/config.toml (merge this section into that file)", open: "Open ~/.codex/config.toml in your editor. This download contains only the Omamorisan section, not your full Codex settings.", finish: "Restart the Codex session. Run codex mcp list to check the server; use /mcp in the CLI to inspect tools.", docs: "https://developers.openai.com/codex/mcp/" },
  { id: "vscode", name: "VS Code / Copilot", file: "mcp.json", destination: "Your VS Code user MCP configuration (opened by the command below)", open: "Open the Command Palette (Cmd+Shift+P on Mac, Ctrl+Shift+P on Windows/Linux). Run MCP: Open User Configuration.", finish: "Save, start omamorisan using the MCP configuration controls, and enable its tools in agent chat.", docs: "https://code.visualstudio.com/docs/agent-customization/mcp-servers" },
  { id: "windsurf", name: "Windsurf / Cascade", file: "mcp_config.json", destination: "The mcp_config.json opened by your Cascade settings", open: "In Cascade, open the MCP settings and choose the raw configuration / Open MCP config file action. Use that file; its location varies by app version.", finish: "Save and refresh the MCP servers in Cascade. Enable omamorisan.", docs: "https://docs.windsurf.com/windsurf/cascade/mcp" },
  { id: "gemini", name: "Gemini CLI", file: "settings.json", destination: "~/.gemini/settings.json", open: "Open the .gemini folder in your home directory and edit settings.json. Create the folder and file if they do not exist.", finish: "Restart Gemini CLI. Use /mcp to inspect the connected server and tools.", docs: "https://geminicli.com/docs/tools/mcp-server/" },
] as const;

export type McpClientId = (typeof MCP_CLIENTS)[number]["id"];

export function mcpConfiguration(client: McpClientId, agentKey: string, entryPath: string, bunPath = "bun"): string {
  const env = { OMAMORISAN_AGENT_KEY: agentKey, OMAMORISAN_FIREWALL_URL: SITE.firewallUrl };
  const server = { command: bunPath, args: [entryPath], env };
  if (client === "codex") {
    // JSON basic strings are valid TOML strings for these paths and credentials.
    return `[mcp_servers.omamorisan]\ncommand = ${JSON.stringify(bunPath)}\nargs = [${JSON.stringify(entryPath)}]\n\n[mcp_servers.omamorisan.env]\nOMAMORISAN_AGENT_KEY = ${JSON.stringify(agentKey)}\nOMAMORISAN_FIREWALL_URL = ${JSON.stringify(SITE.firewallUrl)}\n`;
  }
  return JSON.stringify(client === "vscode" ? { servers: { omamorisan: { type: "stdio", ...server } } } : { mcpServers: { omamorisan: server } }, null, 2) + "\n";
}

export function isAbsoluteEntryPath(path: string): boolean {
  return /^(\/|[A-Za-z]:[\\/])/.test(path) && /[\\/]apps[\\/]mcp[\\/]index\.ts$/.test(path);
}
