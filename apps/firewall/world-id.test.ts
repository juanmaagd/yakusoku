import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  ACR_ORB_V3,
  pollDeviceToken,
  pollUntilResolved,
  validateIdToken,
  type PollOutcome,
} from "./world-id";

// No network — every test either stubs `fetch` (poll-state-machine cases) or
// signs/validates a locally generated keypair (ID-token validation cases).
// Runtime code (world-id.ts) always calls the real sandbox; this is the one
// place a stub/local keypair is allowed (mirrors intercepta.test.ts).

const ENV_KEYS = ["WORLD_CLIENT_ID", "WORLD_CLIENT_SECRET", "WORLD_ID_ISSUER"] as const;
const ORIGINAL_FETCH = globalThis.fetch;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as typeof savedEnv;
  process.env.WORLD_CLIENT_ID = "test-client-id";
  process.env.WORLD_CLIENT_SECRET = "test-client-secret";
  process.env.WORLD_ID_ISSUER = "https://sandbox.auth.world.org";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- pollDeviceToken / pollUntilResolved (poll-state machine) --------------

describe("pollDeviceToken", () => {
  test("authorization_pending", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ error: "authorization_pending" }, 400)) as unknown as typeof fetch;
    const outcome = await pollDeviceToken("device-1");
    expect(outcome).toEqual({ status: "pending" });
  });

  test("slow_down", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ error: "slow_down" }, 400)) as unknown as typeof fetch;
    const outcome = await pollDeviceToken("device-1");
    expect(outcome).toEqual({ status: "slow_down" });
  });

  test("access_denied", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ error: "access_denied" }, 400)) as unknown as typeof fetch;
    const outcome = await pollDeviceToken("device-1");
    expect(outcome).toEqual({ status: "denied" });
  });

  test("expired_token", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ error: "expired_token" }, 400)) as unknown as typeof fetch;
    const outcome = await pollDeviceToken("device-1");
    expect(outcome).toEqual({ status: "expired" });
  });

  test("approved", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ id_token: "the-id-token" }, 200)) as unknown as typeof fetch;
    const outcome = await pollDeviceToken("device-1");
    expect(outcome).toEqual({ status: "approved", idToken: "the-id-token" });
  });

  test("network error -> error, never approved", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const outcome = await pollDeviceToken("device-1");
    expect(outcome.status).toBe("error");
  });

  test("unrecognized error code -> error, never approved", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ error: "some_new_error" }, 400)) as unknown as typeof fetch;
    const outcome = await pollDeviceToken("device-1");
    expect(outcome.status).toBe("error");
  });
});

describe("pollUntilResolved", () => {
  function stubSequence(outcomes: (Response | Promise<never>)[]): void {
    let i = 0;
    globalThis.fetch = mock(async () => {
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      return next;
    }) as unknown as typeof fetch;
  }
  const noopSleep = async () => {};

  test("authorization_pending then approved resolves approved", async () => {
    stubSequence([jsonResponse({ error: "authorization_pending" }, 400), jsonResponse({ id_token: "tok" }, 200)]);
    const ticks: PollOutcome[] = [];
    const outcome = await pollUntilResolved({
      deviceCode: "device-1",
      initialIntervalSeconds: 1,
      deadlineMs: Date.now() + 60_000,
      sleep: noopSleep,
      onTick: (o) => {
        ticks.push(o);
      },
    });
    expect(outcome).toEqual({ status: "approved", idToken: "tok" });
    expect(ticks.map((t) => t.status)).toEqual(["pending", "approved"]);
  });

  test("access_denied resolves denied", async () => {
    stubSequence([jsonResponse({ error: "access_denied" }, 400)]);
    const outcome = await pollUntilResolved({
      deviceCode: "device-1",
      initialIntervalSeconds: 1,
      deadlineMs: Date.now() + 60_000,
      sleep: noopSleep,
    });
    expect(outcome).toEqual({ status: "denied" });
  });

  test("expired_token resolves expired", async () => {
    stubSequence([jsonResponse({ error: "expired_token" }, 400)]);
    const outcome = await pollUntilResolved({
      deviceCode: "device-1",
      initialIntervalSeconds: 1,
      deadlineMs: Date.now() + 60_000,
      sleep: noopSleep,
    });
    expect(outcome).toEqual({ status: "expired" });
  });

  test("slow_down increases the interval and keeps polling", async () => {
    stubSequence([
      jsonResponse({ error: "slow_down" }, 400),
      jsonResponse({ error: "slow_down" }, 400),
      jsonResponse({ id_token: "tok" }, 200),
    ]);
    const seenIntervals: number[] = [];
    const outcome = await pollUntilResolved({
      deviceCode: "device-1",
      initialIntervalSeconds: 5,
      deadlineMs: Date.now() + 60_000,
      sleep: noopSleep,
      onTick: (_o, interval) => {
        seenIntervals.push(interval);
      },
    });
    expect(outcome).toEqual({ status: "approved", idToken: "tok" });
    // Each slow_down adds 5s: 5 -> 10 -> 15 (the third tick is the terminal
    // "approved" at the by-then-bumped interval).
    expect(seenIntervals).toEqual([10, 15, 15]);
  });

  test("network error resolves error (fail-closed, never approved)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const outcome = await pollUntilResolved({
      deviceCode: "device-1",
      initialIntervalSeconds: 1,
      deadlineMs: Date.now() + 60_000,
      sleep: noopSleep,
    });
    expect(outcome.status).toBe("error");
  });

  test("deadline already passed resolves expired without polling", async () => {
    const fetchMock = mock(async () => jsonResponse({ id_token: "tok" }, 200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const outcome = await pollUntilResolved({
      deviceCode: "device-1",
      initialIntervalSeconds: 1,
      deadlineMs: Date.now() - 1,
      sleep: noopSleep,
    });
    expect(outcome).toEqual({ status: "expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- validateIdToken (local keypair, no network) ----------------------------

describe("validateIdToken", () => {
  const ISSUER = "https://sandbox.auth.world.org";
  const AUDIENCE = "test-client-id";

  async function makeKeypairAndJwks() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const jwks = createLocalJWKSet({ keys: [jwk] });
    return { privateKey, jwks };
  }

  async function signToken(
    privateKey: CryptoKey,
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; expiresInSeconds?: number } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.expiresInSeconds ?? 3600))
      .sign(privateKey);
  }

  test("valid, fresh token -> valid", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, { sub: "user-1", acr: ACR_ORB_V3, auth_time: now, amr: ["pop"] });

    const result = await validateIdToken(token, {
      requestedAtSeconds: now - 10,
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.sub).toBe("user-1");
      expect(result.claims.acr).toBe(ACR_ORB_V3);
    }
  });

  test("wrong audience -> rejected", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      privateKey,
      { sub: "user-1", acr: ACR_ORB_V3, auth_time: now },
      { audience: "someone-elses-client-id" },
    );

    const result = await validateIdToken(token, {
      requestedAtSeconds: now - 10,
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
  });

  test("wrong issuer -> rejected", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      privateKey,
      { sub: "user-1", acr: ACR_ORB_V3, auth_time: now },
      { issuer: "https://evil.example.org" },
    );

    const result = await validateIdToken(token, {
      requestedAtSeconds: now - 10,
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
  });

  test("expired token -> rejected", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      privateKey,
      { sub: "user-1", acr: ACR_ORB_V3, auth_time: now - 1000 },
      { expiresInSeconds: -10 }, // already expired
    );

    const result = await validateIdToken(token, {
      requestedAtSeconds: now - 1010,
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
  });

  test("stale auth_time (older than the freshness window) -> rejected", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const staleAuthTime = now - 600; // 10 minutes ago
    const token = await signToken(privateKey, { sub: "user-1", acr: ACR_ORB_V3, auth_time: staleAuthTime });

    const result = await validateIdToken(token, {
      requestedAtSeconds: staleAuthTime - 10,
      maxAuthAgeSeconds: 300, // 5 minute window — 10 minutes old is stale
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("freshness window");
  });

  test("auth_time predates the approval request -> rejected (reused/replayed authentication)", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const oldAuthTime = now - 120;
    const token = await signToken(privateKey, { sub: "user-1", acr: ACR_ORB_V3, auth_time: oldAuthTime });

    // The device flow was requested well after this token's auth_time.
    const result = await validateIdToken(token, {
      requestedAtSeconds: now, // requested "now", but auth_time is 2 minutes in the past
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("predates");
  });

  test("missing auth_time -> rejected", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, { sub: "user-1", acr: ACR_ORB_V3 });

    const result = await validateIdToken(token, {
      requestedAtSeconds: now - 10,
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("auth_time");
  });

  test("unexpected acr -> rejected", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, { sub: "user-1", acr: "https://world.org/oidc/acr/selfie", auth_time: now });

    const result = await validateIdToken(token, {
      requestedAtSeconds: now - 10,
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
  });

  test("tampered signature -> rejected", async () => {
    const { privateKey, jwks } = await makeKeypairAndJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, { sub: "user-1", acr: ACR_ORB_V3, auth_time: now });
    const tampered = `${token.slice(0, -4)}abcd`;

    const result = await validateIdToken(tampered, {
      requestedAtSeconds: now - 10,
      maxAuthAgeSeconds: 300,
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.valid).toBe(false);
  });
});
