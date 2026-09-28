import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  AgentSessionWrapper,
  reclaimIdleRpcSession,
  runMemoryPressureReclaim,
} = await jiti.import("./rpc-manager.ts");
const {
  acquireSessionPresence,
  releaseSessionPresence,
} = await jiti.import("./session-liveness.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Place a wrapper where the registry looks, and clean it up after. */
function registerWrapper(t, wrapper) {
  // The first call initializes the global registry and installs the
  // presence-release listener.
  reclaimIdleRpcSession("__warmup__");
  const sessionId = wrapper.sessionId;
  globalThis.__piSessions.set(sessionId, wrapper);
  wrapper.onDestroy(() => {
    if (globalThis.__piSessions.get(sessionId) === wrapper) globalThis.__piSessions.delete(sessionId);
  });
  t.after(() => {
    if (globalThis.__piSessions.get(sessionId) === wrapper) globalThis.__piSessions.delete(sessionId);
  });
  return sessionId;
}

test("a pressure pass reclaims idle wrappers oldest first", async (t) => {
  const wrappers = [];
  for (const id of ["pressure-old", "pressure-middle", "pressure-new"]) {
    const wrapper = new AgentSessionWrapper(makeInner(id));
    wrapper.start();
    t.after(() => wrapper.destroy());
    registerWrapper(t, wrapper);
    wrappers.push(wrapper);
    await sleep(3);
  }

  const result = runMemoryPressureReclaim();
  assert.deepEqual(result.reclaimed, ["pressure-old", "pressure-middle", "pressure-new"]);
  assert.equal(result.reclaimable, 3);
  assert.equal(result.running, 0);
  assert.equal(result.viewed, 0);

  await nextTurn();
  for (const wrapper of wrappers) assert.equal(wrapper.isAlive(), false);
});

test("a running session is never interrupted and is reclaimed once it settles", async (t) => {
  const inner = makeInner("pressure-running");
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

  const result = runMemoryPressureReclaim();
  assert.deepEqual(result.reclaimed, []);
  assert.equal(result.reclaimable, 0);
  assert.equal(result.running, 1);
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

test("a session another viewer holds blocks reclaim until it leaves", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner("pressure-viewed"));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  acquireSessionPresence("pressure-viewed", "tab-a");
  const result = runMemoryPressureReclaim();
  assert.deepEqual(result.reclaimed, []);
  assert.equal(result.reclaimable, 0);
  assert.equal(result.viewed, 1);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isClosing(), false);

  releaseSessionPresence("pressure-viewed", "tab-a");
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("over target with nothing reclaimable closes nothing and reports it", async (t) => {
  const inner = makeInner("pressure-nothing");
  let sdkListener;
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const running = new AgentSessionWrapper(inner);
  running.start();
  t.after(() => running.destroy());
  registerWrapper(t, running);

  const viewed = new AgentSessionWrapper(makeInner("pressure-nothing-viewed"));
  viewed.start();
  t.after(() => viewed.destroy());
  registerWrapper(t, viewed);

  acquireSessionPresence("pressure-nothing-viewed", "tab-a");
  t.after(() => releaseSessionPresence("pressure-nothing-viewed", "tab-a"));

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });

  const result = runMemoryPressureReclaim();
  assert.deepEqual(result.reclaimed, []);
  assert.equal(result.reclaimable, 0);
  assert.equal(result.running, 1);
  assert.equal(result.viewed, 1);
  await nextTurn();
  assert.equal(running.isAlive(), true);
  assert.equal(viewed.isAlive(), true);

  // The running one is still skipped here, but settles into a reclaim.
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  await nextTurn();
  assert.equal(running.isAlive(), false);
  // The viewed one is untouched: another tab is still looking at it.
  assert.equal(viewed.isAlive(), true);
});
