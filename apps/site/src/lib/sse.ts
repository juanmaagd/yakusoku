// Fetch-based SSE client for the P6 dashboard — deliberately NOT the
// browser's native `EventSource`. QA cross-checked (curl, a raw `fetch()` +
// stream reader, and a same-origin `EventSource` control) found the native
// `EventSource` never fires `open` or `error` for this dashboard's
// cross-origin (site -> firewall) stream in the tested Chrome build, while a
// manual `fetch()` reads the exact same bytes (including live heartbeats)
// without issue. Rather than depend on EventSource's cross-origin behavior
// at all, this parses `event:`/`data:` frames from a fetch body reader —
// the same minimal parser apps/firewall/scripts/scenarios.ts already uses on
// the Node side (`collectSseEvents`) for the identical wire format.

export interface SseFrame {
  event: string;
  data: string;
}

/** Streams `url`, calling `onOpen` once headers arrive and `onFrame` for
 * every parsed frame, until `signal` aborts or the server closes the
 * connection. Throws on a failed connect or a read error. */
export async function streamSse(
  url: string,
  signal: AbortSignal,
  onOpen: () => void,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  // No custom `Accept` header here on purpose: it's outside the firewall's
  // CORS `Access-Control-Allow-Headers` list (index.ts), which turns this
  // fetch into a preflighted cross-origin request that never resolves in
  // some browser/CORS-middleware combinations (confirmed while QA'ing this
  // exact dashboard) instead of failing fast — the server doesn't need it
  // to serve the stream anyway.
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
  onOpen();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventMatch = /^event: (.+)$/m.exec(raw);
      const dataMatch = /^data: (.*)$/m.exec(raw);
      if (eventMatch?.[1]) onFrame({ event: eventMatch[1], data: dataMatch?.[1] ?? "" });
    }
  }
}

export type SseConnectionStatus = "connecting" | "connected" | "disconnected";

/** Runs `streamSse` in a retry-forever loop — the dashboard's whole "live
 * updates" lifecycle in one call. Returns a cleanup function that stops the
 * loop and aborts any in-flight connection. */
export function connectSseWithRetry(
  url: string,
  onStatusChange: (status: SseConnectionStatus) => void,
  onFrame: (frame: SseFrame) => void,
  retryDelayMs = 2000,
): () => void {
  const controller = new AbortController();
  let stopped = false;

  async function loop() {
    while (!stopped) {
      onStatusChange("connecting");
      try {
        await streamSse(url, controller.signal, () => onStatusChange("connected"), onFrame);
        if (stopped) return;
      } catch {
        if (stopped) return;
      }
      onStatusChange("disconnected");
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  void loop();
  return () => {
    stopped = true;
    controller.abort();
  };
}
