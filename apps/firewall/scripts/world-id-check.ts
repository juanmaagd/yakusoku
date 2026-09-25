#!/usr/bin/env bun
// WU11 live check — a real sandbox device authorization, runnable without a
// phone: starts the flow, prints `user_code` + `verification_uri_complete`,
// and polls for ~15s observing `authorization_pending`. With `--wait`, it
// keeps polling until a human approves/denies/lets it expire from their
// World App, then validates the resulting ID token exactly as
// approvals.ts's background resolver does.
//
// Never prints the id_token itself, only its validated claims — track
// requirement (docs/tracks/world.md): "Validate identity results in a
// secure backend; do not expose client secrets or treat an unvalidated
// client response as authorization."

import { pollDeviceToken, pollUntilResolved, startDeviceAuthorization, validateIdToken } from "../world-id";

const WAIT = process.argv.includes("--wait");

async function main(): Promise<void> {
  if (!process.env.WORLD_CLIENT_ID || !process.env.WORLD_CLIENT_SECRET) {
    console.log("WORLD_CLIENT_ID/WORLD_CLIENT_SECRET missing — WU11 live check pending");
    process.exit(2);
  }

  console.log("=== 1. Starting a real World ID sandbox device authorization ===");
  const requestedAt = new Date();
  const device = await startDeviceAuthorization();
  console.log(`user_code: ${device.userCode}`);
  console.log(`verification_uri_complete: ${device.verificationUriComplete ?? device.verificationUri}`);
  console.log(`expires_in: ${device.expiresIn}s, interval: ${device.interval}s`);

  if (!WAIT) {
    console.log("\n=== 2. Observing ~15s of polling (expect authorization_pending) ===");
    const deadline = Date.now() + 15_000;
    let sawPending = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, device.interval * 1000));
      if (Date.now() >= deadline) break;
      const outcome = await pollDeviceToken(device.deviceCode);
      console.log(`poll -> ${outcome.status}`);
      if (outcome.status === "pending") sawPending = true;
      if (outcome.status === "approved" || outcome.status === "denied") {
        console.log("(resolved already — rerun with --wait to validate/observe the full outcome)");
        break;
      }
    }
    if (!sawPending) {
      console.error("\nFAILED: never observed authorization_pending in ~15s — check device_authorization/token wiring.");
      process.exit(1);
    }
    console.log("\nOK: device_authorization succeeded and polling observed authorization_pending.");
    console.log("Re-run with --wait to approve from your World App and validate the resulting ID token.");
    return;
  }

  console.log("\n=== 2. --wait: polling until approved/denied/expired (approve from your World App) ===");
  const outcome = await pollUntilResolved({
    deviceCode: device.deviceCode,
    initialIntervalSeconds: device.interval,
    deadlineMs: requestedAt.getTime() + device.expiresIn * 1000,
    onTick: (o, interval) => console.log(`poll -> ${o.status} (interval now ${interval}s)`),
  });

  if (outcome.status === "denied") {
    console.log("\nRESULT: denied — the human rejected the approval (expected fail-closed refuse downstream).");
    return;
  }
  if (outcome.status === "expired") {
    console.log("\nRESULT: expired — no response within the window (expected fail-closed refuse downstream).");
    return;
  }
  if (outcome.status === "error") {
    console.log(`\nRESULT: error — ${outcome.message} (expected fail-closed refuse downstream).`);
    process.exitCode = 1;
    return;
  }

  console.log("\n=== 3. approved — validating the ID token (never printing the token itself) ===");
  const validation = await validateIdToken(outcome.idToken, {
    requestedAtSeconds: Math.floor(requestedAt.getTime() / 1000),
    maxAuthAgeSeconds: 300,
  });
  if (!validation.valid) {
    console.error(`FAILED: token did not validate: ${validation.reason}`);
    process.exit(1);
  }
  console.log("RESULT: approved and VALID.");
  console.log(`  sub: ${validation.claims.sub}`);
  console.log(`  acr: ${validation.claims.acr}`);
  console.log(
    `  auth_time: ${validation.claims.authTime} (${new Date(validation.claims.authTime * 1000).toISOString()})`,
  );
  console.log(`  amr: ${JSON.stringify(validation.claims.amr)}`);
}

main().catch((err) => {
  console.error("world-id-check script crashed:", err);
  process.exit(1);
});
