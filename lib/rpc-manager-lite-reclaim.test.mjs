import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, reclaimIdleRpcSession } = await jiti.import("./rpc-manager.ts");
const {
  acquireSessionPresence,
  registerSessionLivenessProvider,
  releaseSessionPresence,
} = await jiti.import("./session-liveness.ts");
const { clearDelegatedWorkCache } = await jiti.import("./delegated-work.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
// The wrapper resolves its idle window once at import time; with the env var
// unset that is the 10-minute default the tests below tick.
const IDLE_WINDOW_MS = 10 * 60 * 1000;

function makeInner(sessionId, sessionFile) {
  return {
    sessionId,
    sessionFile,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: { async emit() {} },
    sessionManager: {
      getCwd: () => "/tmp",
      getSessionFile: () => sessionFile,
      getHeader: () => undefined,
      getEntries: () => [],
    },
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: () => Promise.resolve(),
    subscribe: () => () => {},
    dispose() {},
  };
}

/** Place a wrapper where reclaimIdleRpcSession looks, and clean it up after. */
function registerWrapper(t, wrapper) {
  // The first call initializes the global registry and installs the
  // presence-release listener that drives reclaim.
  reclaimIdleRpcSession("__warmup__");
  const sessionId = wrapper.sessionId;
  globalThis.__piSessions.set(sessionId, wrapper);
  t.after(() => {
    if (globalThis.__piSessions.get(sessionId) === wrapper) globalThis.__piSessions.delete(sessionId);
  });
  return sessionId;
}

test("reclaims an idle wrapper that no page is viewing", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner("lite-idle"));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  assert.equal(wrapper.isClosing(), false);
  assert.equal(reclaimIdleRpcSession("lite-idle"), true);
  assert.equal(wrapper.isClosing(), true, "a reclosing wrapper reports itself closing at once");
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("an unknown session or an already-closing wrapper is not reclaimed twice", async (t) => {
  assert.equal(reclaimIdleRpcSession("no-such-session"), false);

  const wrapper = new AgentSessionWrapper(makeInner("lite-double"));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  assert.equal(reclaimIdleRpcSession("lite-double"), true);
  assert.equal(reclaimIdleRpcSession("lite-double"), false, "the second call finds it closing");
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("keeps the wrapper while another page still holds the same session", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner("lite-multi"));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  acquireSessionPresence("lite-multi", "tab-b");
  acquireSessionPresence("lite-multi", "tab-a");
  // tab-a switches away; tab-b is still viewing.
  releaseSessionPresence("lite-multi", "tab-a");
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isClosing(), false);

  // Last viewer leaves: now the idle wrapper is reclaimed.
  releaseSessionPresence("lite-multi", "tab-b");
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("a page that only holds a connection lease still protects the session", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner("lite-normal-viewer"));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  const release = registerSessionLivenessProvider({
    name: "plain-viewer",
    sessionId: "lite-normal-viewer",
    isActive: () => true,
  });
  t.after(release);

  assert.equal(reclaimIdleRpcSession("lite-normal-viewer"), false);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isClosing(), false);
});

test("never interrupts a running task; the idle timer closes it once the run settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const inner = makeInner("lite-running");
  let sdkListener;
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });

  acquireSessionPresence("lite-running", "tab-a");
  releaseSessionPresence("lite-running", "tab-a");
  await nextTurn();
  assert.equal(wrapper.isAlive(), true, "the page leaving does not kill a running turn");

  // The run settles, which starts a fresh idle window: reclaiming is now the
  // idle timer's job, not the presence release's.
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);

  t.mock.timers.tick(IDLE_WINDOW_MS);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("a delegated child still writing keeps the session from being reclaimed", async (t) => {
  clearDelegatedWorkCache();
  const root = mkdtempSync(join(tmpdir(), "pi-web-lite-reclaim-delegated-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, "", "utf8");
  mkdirSync(join(root, "session", "child-1", "run-0"), { recursive: true });
  writeFileSync(join(root, "session", "child-1", "run-0", "session.jsonl"), "", "utf8");

  const wrapper = new AgentSessionWrapper(makeInner("lite-delegated", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  assert.equal(wrapper.isBusy(), true);
  assert.equal(reclaimIdleRpcSession("lite-delegated"), false);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isClosing(), false);
});
