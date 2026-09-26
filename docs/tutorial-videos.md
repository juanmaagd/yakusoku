# Embedded frontend walkthroughs

The tutorials live on the screens they explain, not on a separate help page.

| Screen | Clip |
| --- | --- |
| Landing page, after How it works | `overview.mp4` |
| Wallet sign-in on either app route | `signin.mp4` |
| Intents list | `promises.mp4` |
| New intent form | `create.mp4` |
| One-time agent key handoff | `connect.mp4` |
| Live dashboard | `live.mp4` |
| Pending World ID approval | `approval.mp4` |

All files are served locally from `apps/site/public/tutorials`. Each clip has a poster, English WebVTT captions, and phase descriptions in its player. A compact dock (a small chip on phones, minimizable on larger screens) opens into a panel at the right of the current page on desktop, which the page makes room for in the same motion, or a bottom sheet on phones. The player uses its own controls: play/pause, a scrubber with phase ticks, time, step counter, captions and fullscreen. Choosing a phase seeks the video, and the active phase shows its own progress as playback advances. The videos are captioned screen walkthroughs without voice or music. Nothing plays on page load; playback starts when the visitor opens the panel. The compact dock does not load video data until opened.

`apps/site/src/lib/tutorial-chapters.json` (a copy of `public/tutorials/chapters.json`, both written by the recorder) is the single source of phase timing for the player.

`apps/site/src/lib/tutorials.json` is the source of the on-screen guidance and transcripts. `TutorialVideo.tsx` embeds the matching clip. The connection screen also provides client-specific configuration downloads in `ConnectionSetup.tsx` and `lib/mcpSetup.ts`.

## Regenerate the videos

Prerequisites: Node, FFmpeg, Playwright, and an installed Chromium browser. Use a temporary Playwright installation if it is not already available; production dependencies do not need it.

1. Start the frontend from the repository root with `bun run site`.
2. Install Playwright into a temporary folder if needed: `npm install --prefix /tmp/omamorisan-video-tools playwright`.
3. Run the recorder from the repository root:

```bash
PLAYWRIGHT_MODULE=/tmp/omamorisan-video-tools/node_modules/playwright/index.mjs \
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scripts/record-tutorials.mjs
```

Use the browser executable path for your operating system. Omit `CHROME_PATH` to use Playwright's installed Chromium. `TUTORIAL_ORIGIN` defaults to `http://localhost:4321`; `TUTORIAL_WORK_DIR` defaults to `/private/tmp/omamorisan-tutorials` and can be overridden on other platforms.

The recorder interacts with the actual frontend using a fresh browser context. Wallet requests and firewall responses are intercepted with fictional fixtures. External requests are blocked. It never connects a real wallet, reads `.env.local`, creates a real mandate, or submits a payment. Every frame says **EXAMPLE DATA · NO REAL PAYMENT**. Wallet popups and provider application settings are explained in captions, not represented as verified recordings of third-party apps. The World ID QR uses an invalid example URL.

Clips are composed, not screen-recorded. Captures run at 2x device scale, and the recorder measures each step's target and whether it is a control. A composition page using the site's own fonts renders each frame deterministically from a timeline: the camera eases to the step's target, a white veil and an ink ring spotlight it, a cursor glides to it and clicks when the next step is the result of that click, and the caption changes with a staggered reveal. Frames are rendered only while something moves; holds are single frames with a duration. Output is 1920x1080 at 30 fps (H.264). A step lasts `ceil(1.6 + max(5.5, words / 2.7) + 0.6 if it ends in a click)` seconds. The dashboard's event stream is held open in the capture browser so it shows as live.

The recorder validates all seven configuration downloads, checks the mobile handoff for horizontal overflow, and rejects browser runtime errors. Frames go to the temporary work directory; final MP4s, posters, WebVTT, chapters, and combined transcript go to `apps/site/public/tutorials`.

After generation, run `bun run --filter @yakusoku/site typecheck` and `bun run --filter @yakusoku/site build`. Verify video decoding and embedded playback with `scripts/verify-tutorials.mjs` using the same Playwright/browser environment variables.

## Client configuration sources

Checked September 26, 2026. Instructions are selected by the MCP client application, not its model provider. The UI links these sources for app-version-specific details.

- [Claude Desktop local server setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [Cursor MCP configuration](https://cursor.com/docs/context/mcp)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [VS Code MCP setup](https://code.visualstudio.com/docs/agent-customization/mcp-servers) and [configuration schema](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Windsurf/Cascade MCP configuration](https://docs.windsurf.com/windsurf/cascade/mcp) — this URL currently redirects to the Cascade documentation under Devin; use the app's Open MCP config action rather than assuming a legacy path.
- [Gemini CLI MCP configuration](https://geminicli.com/docs/tools/mcp-server/)

Generated configurations include the one-time mandate credential. Downloads are not automatically installed; the page explicitly gives the save destination and asks users to merge with existing settings. No file is written outside the user's chosen browser download location. A local development build prefills the MCP entry path; a production build leaves it for the user to enter. Never embed a real agent key in a video, screenshot, transcript, or committed example.
