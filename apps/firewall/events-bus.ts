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
  | "settlement.reported"
  // WU11: the World ID human-approval gate (approvals.ts) starting a device
  // flow, and later resolving it (approved/denied/expired/error).
  | "approval.requested"
  | "approval.resolved"
  // WU13: the kill switch changing state, and an intent being revoked.
  | "control.changed"
  | "intent.revoked"
  // P9.1/P9.2: an account finishing its World ID connect device flow, and a
  // promise's own device flow being requested/resolved (accounts.ts,
  // promises.ts). Payloads never carry secrets (account keys, poll secrets,
  // the raw World ID subject) — same discipline as `intent.created` never
  // carrying the mandate's agent key.
  | "account.connected"
  | "promise.requested"
  | "promise.approved"
  | "promise.denied";

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
