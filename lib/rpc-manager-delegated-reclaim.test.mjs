import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Point the pi-subagents registry probe at a directory that does not exist so
// this suite exercises the plugin-agnostic artifact-activity signal only.
process.env.PI_WEB_SUBAGENT_RUNS_DIR = join(tmpdir(), "pi-web-delegated-runs-absent");

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, getRunningRpcSessionIds, reclaimIdleRpcSession, runMemoryPressureReclaim } =
  await jiti.import("./rpc-manager.ts");
const { clearDelegatedWorkCache } = await jiti.import("./delegated-work.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

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

/**
 * A session whose artifact directory holds one child run, exactly the layout a
 * delegated subagent leaves behind: `<session>.jsonl` plus `<session>/<child>/run-N/session.jsonl`.
 */
function makeSessionWithChild(t, name) {
  const root = mkdtempSync(join(tmpdir(), `pi-web-delegated-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, "", "utf8");
  const childFile = join(root, "session", "child-1", "run-0", "session.jsonl");
  mkdirSync(join(root, "session", "child-1", "run-0"), { recursive: true });
  writeFileSync(childFile, "", "utf8");
  return { sessionFile, root, childFile };
}

function registerWrapper(t, wrapper) {
  reclaimIdleRpcSession("__warmup__");
  const sessionId = wrapper.sessionId;
  globalThis.__piSessions.set(sessionId, wrapper);
  t.after(() => {
    if (globalThis.__piSessions.get(sessionId) === wrapper) globalThis.__piSessions.delete(sessionId);
  });
  return sessionId;
}

test("a session with a child run writing under it is not reclaimed", async (t) => {
  clearDelegatedWorkCache();
  const { sessionFile } = makeSessionWithChild(t, "idle-with-child");
  const wrapper = new AgentSessionWrapper(makeInner("delegated-idle", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  const sessionId = registerWrapper(t, wrapper);

  assert.equal(wrapper.isRunning(), false);
  assert.equal(wrapper.hasDelegatedWork(), true);
  assert.equal(wrapper.isBusy(), true);
  assert.equal(reclaimIdleRpcSession(sessionId), false);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isClosing(), false);
});

test("the busy snapshot counts a delegated session as running", async (t) => {
  clearDelegatedWorkCache();
  const { sessionFile } = makeSessionWithChild(t, "snapshot");
  const wrapper = new AgentSessionWrapper(makeInner("delegated-snapshot", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  const sessionId = registerWrapper(t, wrapper);

  assert.ok(getRunningRpcSessionIds().includes(sessionId));
});

test("the pressure pass reports delegated work and closes nothing", async (t) => {
  clearDelegatedWorkCache();
  const { sessionFile } = makeSessionWithChild(t, "pressure");
  const wrapper = new AgentSessionWrapper(makeInner("delegated-pressure", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  const sessionId = registerWrapper(t, wrapper);

  const result = runMemoryPressureReclaim();
  assert.equal(result.delegated >= 1, true);
  assert.equal(result.reclaimed.includes(sessionId), false);
  assert.equal(result.reclaimable, 0);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
});

test("reclaim resumes once the child has stopped writing", async (t) => {
  clearDelegatedWorkCache();
  const { sessionFile, childFile } = makeSessionWithChild(t, "settled");
  const wrapper = new AgentSessionWrapper(makeInner("delegated-settled", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  const sessionId = registerWrapper(t, wrapper);

  assert.equal(reclaimIdleRpcSession(sessionId), false);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);

  // The child went quiet well beyond the activity window: age every level, the
  // way a real idle tree looks (a fresh child directory mtime counts as work).
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (const path of [childFile, join(childFile, ".."), join(childFile, "..", ".."), join(childFile, "..", "..", "..")]) {
    utimesSync(path, old, old);
  }
  clearDelegatedWorkCache();

  assert.equal(wrapper.hasDelegatedWork(), false);
  assert.equal(reclaimIdleRpcSession(sessionId), true);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("a session without an artifact directory is reclaimed as before", async (t) => {
  clearDelegatedWorkCache();
  const wrapper = new AgentSessionWrapper(makeInner("delegated-plain", ""));
  wrapper.start();
  t.after(() => wrapper.destroy());
  const sessionId = registerWrapper(t, wrapper);

  assert.equal(wrapper.hasDelegatedWork(), false);
  assert.equal(reclaimIdleRpcSession(sessionId), true);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});
