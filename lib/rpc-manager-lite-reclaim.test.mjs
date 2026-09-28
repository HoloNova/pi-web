import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, reclaimIdleRpcSession } = await jiti.import("./rpc-manager.ts");
const {
  acquireSessionPresence,
  registerSessionLivenessProvider,
  releaseSessionPresence,
} = await jiti.import("./session-liveness.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function makeInner(sessionId) {
  return {
    sessionId,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: { async emit() {} },
    sessionManager: {
      getCwd: () => "/tmp",
      getSessionFile: () => undefined,
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
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("keeps the wrapper while another tab still holds the same session", async (t) => {
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

test("reclaim does not close while a non-Lite viewer is attached", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner("lite-normal-viewer"));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  const release = registerSessionLivenessProvider({
    name: "normal-mode-tab",
    sessionId: "lite-normal-viewer",
    isActive: () => true,
  });
  t.after(release);

  assert.equal(reclaimIdleRpcSession("lite-normal-viewer"), false);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isClosing(), false);
});

test("never interrupts a running task and reclaims it after it settles", async (t) => {
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
  assert.equal(wrapper.isAlive(), true);

  inner.isStreaming = false;
  // A single agent_end is not a settle point: retries/compaction may continue.
  sdkListener({ type: "agent_end" });
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);

  sdkListener({ type: "agent_settled" });
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("an admitted prompt defers reclaim until the run finishes", async (t) => {
  const inner = makeInner("lite-prompt");
  let acceptPreflight;
  let finishPrompt;
  inner.prompt = (_message, options) => new Promise((resolve) => {
    acceptPreflight = () => options.preflightResult(true);
    finishPrompt = resolve;
  });
  inner.subscribe = () => () => {};
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  const sending = wrapper.send({ type: "prompt", message: "hello" });
  await nextTurn();
  acceptPreflight();
  await sending;
  assert.equal(wrapper.isRunning(), true);

  acquireSessionPresence("lite-prompt", "tab-a");
  releaseSessionPresence("lite-prompt", "tab-a");
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);

  finishPrompt();
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("a wrapper asked to reclaim reports it is closing before it disposes", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner("lite-closing"));
  wrapper.start();
  t.after(() => wrapper.destroy());

  assert.equal(wrapper.isClosing(), false);
  wrapper.requestIdleReclaim();
  assert.equal(wrapper.isClosing(), true);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});
