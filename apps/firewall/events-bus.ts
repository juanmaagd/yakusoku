// Process-wide SSE fan-out (WU9, ref-typesafe-hono.md §2.5.1). Hono's
// `streamSSE` handles exactly one connection per call — there is no built-in
// multi-client broadcast, so this is the small `Set`-based hub the reference
// doc recommends: each `GET /events` connection subscribes a `send` callback
// here, and `publish` fans one event out to every open connection.

export type FirewallEventName =
  | "intent.created"
  | "sign.requested"
  | "stage.completed"
  | "decision"
  | "settlement.reported";

export interface FirewallEvent {
  id: string;
  event: FirewallEventName;
  payload: unknown;
}

type Subscriber = (evt: FirewallEvent) => void;

const subscribers = new Set<Subscriber>();

export function publish(event: FirewallEventName, payload: unknown): void {
  const evt: FirewallEvent = { id: crypto.randomUUID(), event, payload };
  for (const send of subscribers) send(evt);
}

/** Returns an unsubscribe function. */
export function subscribe(send: Subscriber): () => void {
  subscribers.add(send);
  return () => subscribers.delete(send);
}
