import { useState } from "react";
import { SITE } from "../../config";
import { isAbsoluteEntryPath, MCP_CLIENTS, mcpConfiguration, type McpClientId } from "../../lib/mcpSetup";
import { inputBase, label, primaryButton } from "../../lib/ui";
import CopyButton from "../ui/CopyButton";

export default function ConnectionSetup({ agentKey, entryPath = "" }: { agentKey: string; entryPath?: string }) {
  const [clientId, setClientId] = useState<McpClientId>("claude-desktop");
  const [path, setPath] = useState(entryPath);
  const [bun, setBun] = useState("bun");
  const [saved, setSaved] = useState(false);
  const client = MCP_CLIENTS.find((c) => c.id === clientId)!;
  const valid = isAbsoluteEntryPath(path.trim()) && !!bun.trim();
  const config = mcpConfiguration(clientId, agentKey, path.trim(), bun.trim());

  function download() {
    const url = URL.createObjectURL(new Blob([config], { type: clientId === "codex" ? "text/plain" : "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = client.file;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  }

  return <div className="mt-8 space-y-6 rounded-card border border-hairline bg-surface p-5 md:p-6" id="connect-agent">
    <div>
      <h2 className="text-subheading font-medium">Connect your agent, step by step</h2>
      <p className="mt-2 text-body-sm text-graphite">This setup connects the wallet promise you just signed. Your client starts MCP and supplies its key. Keep the firewall and store running. For the agent-first World ID flow, use <a href="/#setup-agent" className="underline">Set up your agent</a> on the home page; it needs no copied key.</p>
    </div>
    <div>
      <label className={label} htmlFor="mcp-client">1. Which app do you use?</label>
      <select id="mcp-client" className={`${inputBase} mt-2`} value={clientId} onChange={(e) => { setClientId(e.target.value as McpClientId); setSaved(false); }}>
        {MCP_CLIENTS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <p className="mt-2 text-caption text-graphite">These are MCP clients, not model providers. Choose the app, regardless of which model it uses. Using another client? See the HTTP option below.</p>
    </div>
    <div>
      <label className={label} htmlFor="mcp-entry">2. Confirm the MCP file on your computer</label>
      <input id="mcp-entry" className={`${inputBase} mt-2 font-mono text-body-sm`} value={path} onChange={(e) => { setPath(e.target.value); setSaved(false); }} placeholder="/full/path/to/yakusoku/apps/mcp/index.ts" spellCheck={false} />
      <p className="mt-2 text-caption text-graphite">For this local development site, the path is prefilled. On another computer, open the repository folder, run <code>pwd</code> (PowerShell: <code>(Get-Location).Path</code>), and append <code>/apps/mcp/index.ts</code>. The file must exist on the machine running your agent app.</p>
      <label className={`${label} mt-3`} htmlFor="mcp-bun">Bun executable</label>
      <input id="mcp-bun" className={`${inputBase} mt-2 font-mono text-body-sm`} value={bun} onChange={(e) => { setBun(e.target.value); setSaved(false); }} spellCheck={false} />
      <p className="mt-2 text-caption text-graphite">If your app cannot find Bun, run <code>command -v bun</code> (PowerShell: <code>(Get-Command bun).Source</code>) and use that full path here.</p>
    </div>
    <div>
      <h3 className={label}>3. Save the configuration in {client.name}</h3>
      <p className="mt-2 text-body-sm text-graphite">{client.open}</p>
      <p className="mt-2 break-all rounded-btn bg-fog p-3 font-mono text-caption">{client.destination}</p>
      <p className="mt-2 text-body-sm text-graphite">Download the file below, then move its contents to that location. Downloads go to your browser&rsquo;s download folder; downloading alone does not install MCP. If a file already exists, merge only the omamorisan entry and keep your other settings.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={!valid} className={primaryButton} onClick={download}>Download {client.file}</button>
        {valid && <CopyButton value={config} label="Copy configuration" ariaLabel="Copy MCP configuration" />}
      </div>
      {!valid && <p className="mt-2 text-body-sm text-refuse-ink">Enter the full path ending in apps/mcp/index.ts and a Bun executable first.</p>}
      <p role="status" className="mt-2 text-caption text-graphite">{saved ? `Download requested. Open ${client.file} from Downloads and follow the save location above.` : "This file contains your agent key. Keep it private and out of Git. Use the exact filename, without an added .txt extension."}</p>
      <details className="mt-3 text-body-sm">
        <summary className="cursor-pointer font-medium">Preview configuration (contains your agent key)</summary>
        <pre className="mt-2 overflow-x-auto rounded-btn bg-fog p-3 text-caption">{config}</pre>
      </details>
      <p className="mt-2 text-caption text-graphite">Mac: Finder → Go → Go to Folder opens paths beginning with ~. Windows: paste %APPDATA% paths into File Explorer. Hidden project files can be created directly in your code editor.</p>
    </div>
    <div>
      <h3 className={label}>4. Restart and check the connection</h3>
      <p className="mt-2 text-body-sm text-graphite">{client.finish}</p>
      <p className="mt-2 text-body-sm text-graphite">Ask: <strong>&ldquo;Use Omamorisan get_mandate and tell me my task and remaining budget. Do not buy anything yet.&rdquo;</strong> The answer should match this promise. Payment tools include get_mandate, fetch_url, pay_x402, and check_approval. The same server also supports World ID connection and promise tools.</p>
      <p className="mt-2 text-body-sm text-graphite">You do not run <code>bun index.ts</code> separately for this setup, and you do not add the key to .env.local. The configuration above supplies it. Never paste the key into the model&rsquo;s chat.</p>
      <a className="mt-2 inline-block text-body-sm underline" href={client.docs} target="_blank" rel="noreferrer">Official {client.name} setup instructions ↗</a>
    </div>
    <details className="border-t border-hairline pt-4 text-body-sm">
      <summary className="cursor-pointer font-medium">Other MCP clients / connect over HTTP</summary>
      <p className="mt-3 text-graphite">Use a client that supports Streamable HTTP. From the repository root, start the shared server:</p>
      <pre className="my-3 overflow-x-auto rounded-btn bg-fog p-3 text-caption">cd apps/mcp &amp;&amp; bun index.ts --http</pre>
      <p className="text-graphite">Set its server URL to <code>{SITE.mcpUrl}</code>. For this wallet promise, add an <code>Authorization</code> header with the value below in the client&rsquo;s authentication settings:</p>
      <div className="mt-3"><CopyButton value={`Bearer ${agentKey}`} label="Copy bearer value" /></div>
      <p className="mt-3 text-graphite">Keep that terminal running. Each client sends its own key. A cloud-hosted client cannot reach localhost on your computer; this local setup needs a client running on this machine. For agent-first World ID setup, the HTTP client may connect without a header and call <code>connect</code>.</p>
    </details>
  </div>;
}
