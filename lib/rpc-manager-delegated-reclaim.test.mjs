import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, getRunningRpcSessionIds } = await jiti.import("./rpc-manager.ts");
const { clearDelegatedWorkCache } = await jiti.import("./delegated-work.ts");

// The wrapper resolves its idle window once at import time; with the env var
// unset that is the 10-minute default the tests below tick.
const IDLE_WINDOW_MS = 10 * 60 * 1000;

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
 * delegated child leaves behind: `<session>.jsonl` plus
 * `<session>/<child id>/run-N/session.jsonl`.
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

/** The child stopped writing long enough ago that it no longer counts. */
function ageChildTree(childFile) {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  // Every level, the way a real idle tree looks: a fresh directory mtime counts
  // as activity of its own.
  for (const path of [childFile, join(childFile, ".."), join(childFile, "..", ".."), join(childFile, "..", "..", "..")]) {
    utimesSync(path, old, old);
  }
}

function registerWrapper(t, wrapper) {
  getRunningRpcSessionIds();
  const sessionId = wrapper.sessionId;
  globalThis.__piSessions.set(sessionId, wrapper);
  t.after(() => {
    if (globalThis.__piSessions.get(sessionId) === wrapper) globalThis.__piSessions.delete(sessionId);
  });
  return sessionId;
}

test("the idle path leaves a session whose child is still writing", async (t) => {
  clearDelegatedWorkCache();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessionFile } = makeSessionWithChild(t, "idle-with-child");
  const wrapper = new AgentSessionWrapper(makeInner("delegated-idle", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  assert.equal(wrapper.isRunning(), false);
  assert.equal(wrapper.hasDelegatedWork(), true);
  assert.equal(wrapper.isBusy(), true);

  // The window expires twice while the child keeps writing: delegated work holds
  // the session the same way a running turn does.
  t.mock.timers.tick(IDLE_WINDOW_MS);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  t.mock.timers.tick(IDLE_WINDOW_MS);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
});

test("the busy snapshot counts a delegated session as running", async (t) => {
  clearDelegatedWorkCache();
  const { sessionFile } = makeSessionWithChild(t, "snapshot");
  const wrapper = new AgentSessionWrapper(makeInner("delegated-snapshot", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  const sessionId = registerWrapper(t, wrapper);

  assert.equal(wrapper.isRunning(), false);
  assert.ok(getRunningRpcSessionIds().includes(sessionId));
});

test("a session is reclaimed on the idle window that follows the child, and not before", async (t) => {
  clearDelegatedWorkCache();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessionFile, childFile } = makeSessionWithChild(t, "settled");
  const wrapper = new AgentSessionWrapper(makeInner("delegated-settled", sessionFile));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  t.mock.timers.tick(IDLE_WINDOW_MS);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true, "a writing child holds the session open");

  // The child stops writing while the window it restarted is still running. The
  // session is not reclaimed at that moment — the idle window owns that call.
  ageChildTree(childFile);
  clearDelegatedWorkCache();
  assert.equal(wrapper.hasDelegatedWork(), false);

  t.mock.timers.tick(IDLE_WINDOW_MS - 1);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true, "the child's exit does not close the session on its own");

  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false, "the next idle window reclaims it");
});

test("a running turn is never interrupted by the idle timer", async (t) => {
  clearDelegatedWorkCache();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessionFile, childFile } = makeSessionWithChild(t, "running-turn");
  const inner = makeInner("delegated-running-turn", sessionFile);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  // A running turn holds the session even after the child has gone quiet.
  inner.isStreaming = true;
  ageChildTree(childFile);
  clearDelegatedWorkCache();
  assert.equal(wrapper.isBusy(), true);

  t.mock.timers.tick(IDLE_WINDOW_MS);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true, "a running turn is not interrupted");

  inner.isStreaming = false;
  t.mock.timers.tick(IDLE_WINDOW_MS);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false, "it is reclaimed on the next idle window instead");
});

test("an idle session without delegated work still closes on the idle timer", async (t) => {
  clearDelegatedWorkCache();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wrapper = new AgentSessionWrapper(makeInner("delegated-plain", ""));
  wrapper.start();
  t.after(() => wrapper.destroy());
  registerWrapper(t, wrapper);

  assert.equal(wrapper.hasDelegatedWork(), false);
  assert.equal(wrapper.isBusy(), false);

  t.mock.timers.tick(IDLE_WINDOW_MS);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});
