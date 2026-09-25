/**
 * `JSON.stringify` throws on `bigint` (native ECMAScript behavior, not a
 * viem/wagmi quirk) — `TaskIntentMessage.budget`/`expiry` are bigints, so a
 * signed intent needs this replacer before it can be POSTed
 * (docs/research/ref-wagmi-viem.md §4).
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function stringifyWithBigint(value: unknown, space?: number): string {
  return JSON.stringify(value, bigintReplacer, space);
}

/**
 * There is no matching generic reviver: the ref doc explicitly recommends
 * against one, since a reviver can't tell which numeric strings are meant to
 * become bigints. Instead, `taskIntentMessageSchema` (task-intent.ts) uses
 * `z.coerce.bigint()` on `budget`/`expiry` — parse the JSON normally, then run
 * the result through that schema to get real bigints back.
 */
