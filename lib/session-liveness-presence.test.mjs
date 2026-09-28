import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  SESSION_LIVENESS_LEASE_TTL_MS,
  acquireSessionLivenessLease,
  acquireSessionPresence,
  hasActiveSessionLivenessProvider,
  hasActiveSessionPresence,
  onSessionPresenceReleased,
  releaseSessionPresence,
  renewSessionLivenessLeases,
} = await jiti.import("./session-liveness.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function collectReleases(t) {
  const releases = [];
  const dispose = onSessionPresenceReleased((sessionId, clientId) => releases.push([sessionId, clientId]));
  t.after(dispose);
  return releases;
}

test("presence is scoped to one client and survives another client's release", (t) => {
  const releases = collectReleases(t);
  acquireSessionPresence("session-presence", "tab-a");
  acquireSessionPresence("session-presence", "tab-b");

  assert.equal(hasActiveSessionPresence("session-presence"), true);

  releaseSessionPresence("session-presence", "tab-a");
  assert.equal(hasActiveSessionPresence("session-presence"), true);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-presence" }), true);
  assert.deepEqual(releases, [["session-presence", "tab-a"]]);

  releaseSessionPresence("session-presence", "tab-b");
  assert.equal(hasActiveSessionPresence("session-presence"), false);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-presence" }), false);
  assert.deepEqual(releases, [
    ["session-presence", "tab-a"],
    ["session-presence", "tab-b"],
  ]);
});

test("releasing a client also drops the SSE lease that client owns", (t) => {
  collectReleases(t);
  acquireSessionPresence("session-both", "tab-a");
  const sse = acquireSessionLivenessLease("session-both", { clientId: "tab-a" });
  const otherSse = acquireSessionLivenessLease("session-both", { clientId: "tab-b" });

  releaseSessionPresence("session-both", "tab-a");

  assert.equal(hasActiveSessionPresence("session-both"), false);
  // tab-b's connection lease is untouched.
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-both" }), true);

  sse.release();
  otherSse.release();
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-both" }), false);
});

test("renewing a client is scoped and extends only that client's presence", (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  collectReleases(t);
  acquireSessionPresence("session-renew", "tab-a");
  acquireSessionPresence("session-renew", "tab-b");

  assert.equal(renewSessionLivenessLeases("session-renew", "tab-a"), 1);
  assert.equal(renewSessionLivenessLeases("session-renew", "tab-unknown"), 0);
  assert.equal(renewSessionLivenessLeases("session-renew"), 2);
});

test("an expired lease fallback notifies a reclaim listener", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const releases = collectReleases(t);

  acquireSessionPresence("session-expiry", "tab-a");
  assert.equal(hasActiveSessionPresence("session-expiry"), true);

  now += SESSION_LIVENESS_LEASE_TTL_MS + 1;
  t.mock.timers.tick(SESSION_LIVENESS_LEASE_TTL_MS);
  await nextTurn();

  assert.equal(hasActiveSessionPresence("session-expiry"), false);
  assert.deepEqual(releases, [["session-expiry", "tab-a"]]);
});

test("release is idempotent and notifies once", (t) => {
  const releases = collectReleases(t);
  acquireSessionPresence("session-idem", "tab-a");
  releaseSessionPresence("session-idem", "tab-a");
  releaseSessionPresence("session-idem", "tab-a");
  releaseSessionPresence("session-idem", "tab-b");
  assert.deepEqual(releases, [["session-idem", "tab-a"]]);
});
