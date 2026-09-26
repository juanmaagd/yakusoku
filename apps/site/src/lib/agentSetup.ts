// Per-provider, per-surface setup data for the landing's "Set up your agent"
// section (`SetupAgent.astro` / `SetupAgentCard.tsx`). Adding a fifth provider,
// or a ninth combination, means adding an entry here — never touching the
// section or card components.

import { SITE } from "../config";

export type ProviderId = "claude" | "openai" | "grok" | "gemini";
export type Surface = "app" | "terminal";

export interface SurfaceSetup {
  /** The actual client this combination sets up, e.g. "Claude Code" or "ChatGPT". */
  client: string;
  /** False when this provider can't connect to a custom remote MCP server yet. */
  supported: boolean;
  /** Short, ordered setup steps shown next to the prompt. Empty when unsupported. */
  steps: readonly string[];
  /** Plan or seat requirement shown under the steps, if any. */
  requirement?: string;
  /** Official vendor docs for this exact setup path. Omitted when unsupported. */
  docsUrl?: string;
  /** Quiet explanation shown instead of steps/prompt when unsupported. */
  notice?: string;
  /** Builds the copyable prompt for this combination. Omitted when unsupported. */
  prompt?: () => string;
}

export interface ProviderSetup {
  id: ProviderId;
  name: string;
  app: SurfaceSetup;
  terminal: SurfaceSetup;
}

// The shared instruction every prompt ends with, once the MCP tools are
// available: approve spending rules once (which also connects a new
// account), then reuse that promise for every purchase without asking again.
const FLOW =
  "ask me for my spending rules if I haven't given them yet — what you may buy, which store, a total USDC " +
  "budget, and how long (up to 7 days) — then call `request_promise` once with them and show me the World ID " +
  "link and code so I can approve on my phone; that single approval also connects my account. Show me any setup " +
  "link too so I can fund it. Before every purchase, call `list_promises` and pay through `pay_x402` under an " +
  "active promise that already covers it, without asking me again. If nothing covers it, tell me why and only " +
  "call `request_promise` with `replaces` if I agree to widen the rules. Never retry a refused payment with " +
  "different wording.";

/** Terminal steps are the same shape for every self-installing agent: open it,
 * approve the change and restart, then approve the spending rules in World ID. */
function terminalSteps(client: string): readonly string[] {
  return [
    `Open ${client} in any folder and paste the prompt.`,
    `Approve the change it proposes, restart ${client} when it asks, and paste the prompt again.`,
    "Approve your spending rules in World App on your phone.",
  ];
}

export const AGENT_PROVIDERS: readonly ProviderSetup[] = [
  {
    id: "claude",
    name: "Claude",
    terminal: {
      client: "Claude Code",
      supported: true,
      steps: terminalSteps("Claude Code"),
      docsUrl: "https://code.claude.com/docs/en/mcp",
      prompt: () =>
        `Set up ${SITE.name} so you can buy things for me safely. If the \`omamorisan\` MCP tools aren't available yet, ` +
        `add the server with \`claude mcp add --transport http omamorisan ${SITE.mcpUrl}\`, then tell me to restart Claude Code ` +
        `and paste this prompt again. Once the tools are available, ${FLOW}`,
    },
    app: {
      client: "Claude app (web and desktop)",
      supported: true,
      steps: [
        "In claude.ai or Claude Desktop, open Settings → Connectors → Add custom connector.",
        "Name it Omamorisan and paste the URL below. No sign-in is needed.",
        "In a new chat, turn on Omamorisan from the + menu → Connectors, then paste the prompt.",
      ],
      requirement: "Pro or Max plan. On Team or Enterprise, an owner enables custom connectors first.",
      docsUrl: "https://support.claude.com/en/articles/11175166",
      prompt: () => `Use the ${SITE.name} connector to buy things for me safely. Use only its tools for payments. First, ${FLOW}`,
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    terminal: {
      client: "Codex CLI",
      supported: true,
      steps: terminalSteps("Codex"),
      docsUrl: "https://developers.openai.com/codex/mcp",
      prompt: () =>
        `Set up ${SITE.name} so you can buy things for me safely. If the \`omamorisan\` MCP tools aren't available yet, ` +
        `add it to \`~/.codex/config.toml\` as \`[mcp_servers.omamorisan]\` with \`url = "${SITE.mcpUrl}"\`, keeping any existing entries, ` +
        `then tell me to restart Codex and paste this prompt again. Once the tools are available, ${FLOW}`,
    },
    app: {
      client: "ChatGPT",
      supported: true,
      steps: [
        "On chatgpt.com, open Settings → Security and login and turn on Developer mode.",
        "Go to chatgpt.com/plugins, press +, and create an app with the URL below. Set Authentication to No Authentication.",
        "In a new chat, choose Developer mode from the + menu, select Omamorisan, then paste the prompt. ChatGPT asks you to confirm each Omamorisan action.",
      ],
      requirement: "Plus, Pro, Business, Enterprise or Edu, on the web.",
      docsUrl: "https://developers.openai.com/api/docs/guides/developer-mode",
      prompt: () =>
        `Use the ${SITE.name} app to buy things for me safely. Use only its tools for payments. ` +
        `Do not use browsing or other tools to pay. First, ${FLOW}`,
    },
  },
  {
    id: "grok",
    name: "Grok",
    terminal: {
      client: "Grok Build",
      supported: true,
      steps: terminalSteps("Grok"),
      docsUrl: "https://docs.x.ai/build/features/mcp-servers",
      prompt: () =>
        `Set up ${SITE.name} so you can buy things for me safely. If the \`omamorisan\` MCP tools aren't available yet, ` +
        `add the server with \`grok mcp add --transport http omamorisan ${SITE.mcpUrl}\`, then tell me to restart Grok ` +
        `and paste this prompt again. Once the tools are available, ${FLOW}`,
    },
    app: {
      client: "Grok (grok.com)",
      supported: true,
      steps: [
        "Go to grok.com/connectors, click New Connector, then Custom.",
        "Paste the URL below. No sign-in is needed.",
        "Start a new chat and paste the prompt.",
      ],
      requirement: "Available to all Grok users. On Business or Enterprise, an admin provisions it first.",
      docsUrl: "https://docs.x.ai/grok/connectors",
      prompt: () => `Use the ${SITE.name} connector to buy things for me safely. Use only its tools for payments. First, ${FLOW}`,
    },
  },
  {
    id: "gemini",
    name: "Gemini",
    terminal: {
      client: "Gemini CLI",
      supported: true,
      steps: terminalSteps("Gemini CLI"),
      docsUrl: "https://geminicli.com/docs/tools/mcp-server",
      prompt: () =>
        `Set up ${SITE.name} so you can buy things for me safely. If the \`omamorisan\` MCP tools aren't available yet, ` +
        `add it to \`~/.gemini/settings.json\` under \`mcpServers\` as \`"omamorisan": { "httpUrl": "${SITE.mcpUrl}" }\`, keeping any existing entries, ` +
        `then tell me to restart Gemini CLI and paste this prompt again. Once the tools are available, ${FLOW}`,
    },
    app: {
      client: "Gemini app",
      supported: false,
      steps: [],
      notice: "The Gemini app can't connect to custom MCP servers yet. Use Gemini CLI instead.",
    },
  },
] as const;
