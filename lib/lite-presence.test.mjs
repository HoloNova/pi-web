import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createLitePresenceController } = await jiti.import("./lite-presence.ts");

function makeTransport() {
  const calls = [];
  return {
    calls,
    transport: {
      acquire: (sessionId, clientId) => calls.push(["acquire", sessionId, clientId]),
      renew: (sessionId, clientId) => calls.push(["renew", sessionId, clientId]),
      release: (sessionId, clientId) => calls.push(["release", sessionId, clientId]),
    },
  };
}

test("holds once and renews only while held", () => {
  const { calls, transport } = makeTransport();
  const controller = createLitePresenceController("tab-1", transport);

  controller.hold("session-a");
  controller.hold("session-a");
  controller.renew("session-a");
  controller.renew("session-b");

  assert.deepEqual(calls, [
    ["acquire", "session-a", "tab-1"],
    ["renew", "session-a", "tab-1"],
  ]);
  assert.deepEqual(controller.heldSessionIds(), ["session-a"]);
});

test("a Strict Mode remount cancels the pending release", () => {
  const { calls, transport } = makeTransport();
  const controller = createLitePresenceController("tab-1", transport, { releaseDelayMs: 5 });

  controller.hold("session-a");
  controller.release("session-a");
  // The same effect re-runs immediately; presence was never dropped.
  controller.hold("session-a");

  return new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
    assert.deepEqual(calls, [["acquire", "session-a", "tab-1"]]);
    assert.deepEqual(controller.heldSessionIds(), ["session-a"]);
  });
});

test("a release that is not cancelled drops presence after the grace period", async () => {
  const { calls, transport } = makeTransport();
  const controller = createLitePresenceController("tab-1", transport, { releaseDelayMs: 5 });

  controller.hold("session-a");
  controller.release("session-a");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(calls, [
    ["acquire", "session-a", "tab-1"],
    ["release", "session-a", "tab-1"],
  ]);
  assert.deepEqual(controller.heldSessionIds(), []);
});

test("immediate release and dispose drop presence without waiting", () => {
  const { calls, transport } = makeTransport();
  const controller = createLitePresenceController("tab-1", transport, { releaseDelayMs: 10_000 });

  controller.hold("session-a");
  controller.release("session-a", { immediate: true });
  controller.hold("session-b");
  controller.dispose();

  assert.deepEqual(calls, [
    ["acquire", "session-a", "tab-1"],
    ["release", "session-a", "tab-1"],
    ["acquire", "session-b", "tab-1"],
    ["release", "session-b", "tab-1"],
  ]);
});

test("releasing one session does not disturb another", async () => {
  const { calls, transport } = makeTransport();
  const controller = createLitePresenceController("tab-1", transport, { releaseDelayMs: 5 });

  controller.hold("session-a");
  controller.hold("session-b");
  controller.release("session-a", { immediate: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(controller.heldSessionIds(), ["session-b"]);
  assert.equal(calls.some((call) => call[0] === "release" && call[1] === "session-a"), true);
  assert.equal(calls.some((call) => call[0] === "release" && call[1] === "session-b"), false);
});
