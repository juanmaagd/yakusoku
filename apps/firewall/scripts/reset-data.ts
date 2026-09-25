#!/usr/bin/env bun
// Demo hygiene (HARDEN task) — wipes the firewall's persisted sqlite dir
// (apps/firewall/data/: intents, receipts, idempotency cache, pending World
// ID approvals) so the next demo run starts clean. Refuses if anything is
// currently listening on :4001 — deleting a live firewall's data directory
// out from under it (open bun:sqlite handles, WAL files) would corrupt state
// mid-demo, not just lose history.

import { existsSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const FIREWALL_PORT = Number(process.env.FIREWALL_PORT) || 4001;
const DATA_DIR = join(import.meta.dir, "..", "data");

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false)); // ECONNREFUSED etc. -> nobody listening
    socket.setTimeout(1000, () => finish(false));
  });
}

async function main(): Promise<void> {
  if (await isPortInUse(FIREWALL_PORT)) {
    console.error(
      `[reset-data] refusing: something is listening on :${FIREWALL_PORT} — stop the firewall dev server first ` +
        `(deleting its data directory while it's running would corrupt live sqlite/WAL state).`,
    );
    process.exit(1);
  }
  if (!existsSync(DATA_DIR)) {
    console.log(`[reset-data] ${DATA_DIR} does not exist — nothing to do.`);
    return;
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`[reset-data] deleted ${DATA_DIR}`);
}

main();
