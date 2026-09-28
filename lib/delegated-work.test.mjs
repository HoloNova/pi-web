import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  DEFAULT_DELEGATED_ACTIVITY_WINDOW_MS,
  DELEGATED_WORK_CACHE_TTL_MS,
  MAX_DELEGATED_ACTIVITY_WINDOW_MS,
  MIN_DELEGATED_ACTIVITY_WINDOW_MS,
  clearDelegatedWorkCache,
  hasActivePluginRun,
  hasDelegatedWorkRunning,
  hasRecentArtifactActivity,
  resolveDelegatedActivityWindowMs,
  sessionArtifactDir,
} = await jiti.import("./delegated-work.ts");

const NOW = 1_800_000_000_000;
const WINDOW = 3 * 60 * 1000;
const ARTIFACT_DIR = "/tmp/pi-web-delegated-test/session-abc";
const SESSION_FILE = `${ARTIFACT_DIR}.jsonl`;
const RUNS_DIR = "/tmp/pi-web-delegated-test/async-subagent-runs";

/** Minimal fs seam: keys are absolute paths, `children` marks a directory. */
function fakeFs(spec) {
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const denied = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
  return {
    readdirSync(path) {
      const node = spec[path];
      if (!node || node.deny) throw node?.deny ? denied() : missing();
      return (node.children ?? []).map((name) => ({
        name,
        isDirectory: () => Array.isArray(spec[`${path}/${name}`]?.children),
      }));
    },
    statSync(path) {
      const node = spec[path];
      if (!node) throw missing();
      return { mtimeMs: node.mtimeMs ?? 0 };
    },
    readFileSync(path) {
      const node = spec[path];
      if (!node || node.content === undefined) throw missing();
      return node.content;
    },
  };
}

const runSpec = (runId, status) => ({
  [RUNS_DIR]: { children: [runId], mtimeMs: NOW },
  [`${RUNS_DIR}/${runId}`]: { children: ["status.json"], mtimeMs: NOW },
  [`${RUNS_DIR}/${runId}/status.json`]: { content: JSON.stringify(status), mtimeMs: NOW },
});

const activeRun = (overrides = {}) => ({
  runId: "run-1",
  sessionId: SESSION_FILE,
  sessionRoot: ARTIFACT_DIR,
  state: "running",
  startedAt: NOW - 60_000,
  lastUpdate: NOW - 1_000,
  deadlineAt: NOW + 600_000,
  // A live pid: the default liveness probe is exercised rather than stubbed.
  pid: process.pid,
  ...overrides,
});

test("sessionArtifactDir strips the jsonl suffix only", () => {
  assert.equal(sessionArtifactDir("/sessions/a/session.jsonl"), "/sessions/a/session");
  assert.equal(sessionArtifactDir("/sessions/a/session"), null);
  assert.equal(sessionArtifactDir(""), null);
  assert.equal(sessionArtifactDir(undefined), null);
});

test("artifact activity is recent writes anywhere in the subtree", () => {
  const fs = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: 0 },
    [`${ARTIFACT_DIR}/child-a`]: { children: ["run-0"], mtimeMs: 0 },
    [`${ARTIFACT_DIR}/child-a/run-0`]: { children: ["session.jsonl"], mtimeMs: NOW - 5_000 },
    [`${ARTIFACT_DIR}/child-a/run-0/session.jsonl`]: { mtimeMs: NOW - 5_000 },
  });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), true);
});

test("a fresh write two levels down still counts", () => {
  // Writing a file bumps its immediate directory, not the ancestors — the scan
  // must recurse to see it.
  const fs = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW - 60 * 60 * 1000 },
    [`${ARTIFACT_DIR}/child-a`]: { children: ["run-0"], mtimeMs: NOW - 60 * 60 * 1000 },
    [`${ARTIFACT_DIR}/child-a/run-0`]: { children: ["session.jsonl"], mtimeMs: NOW - 1_000 },
    [`${ARTIFACT_DIR}/child-a/run-0/session.jsonl`]: { mtimeMs: NOW - 60 * 60 * 1000 },
  });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), true);
});

test("artifact activity ignores old writes and a missing directory", () => {
  const fs = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW - 60 * 60 * 1000 },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW - 60 * 60 * 1000 },
  });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), false);
  assert.equal(hasRecentArtifactActivity("/tmp/pi-web-delegated-test/absent", { now: NOW, windowMs: WINDOW, fs }), false);
});

test("an unreadable artifact directory counts as busy", () => {
  const fs = fakeFs({ [ARTIFACT_DIR]: { deny: true, children: [] } });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), true);
});

test("the artifact scan stays bounded", () => {
  const children = Array.from({ length: 700 }, (_, index) => `entry-${index}`);
  const spec = { [ARTIFACT_DIR]: { children, mtimeMs: NOW - 60 * 60 * 1000 } };
  for (const child of children) spec[`${ARTIFACT_DIR}/${child}`] = { mtimeMs: NOW - 60 * 60 * 1000 };
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs: fakeFs(spec) }), false);
});

test("a plugin run for this session that is still working counts as busy", () => {
  const fs = fakeFs(runSpec("run-1", activeRun()));
  assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs }), true);
});

test("a queued plugin run is busy too", () => {
  const fs = fakeFs(runSpec("run-1", activeRun({ state: "queued" })));
  assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs }), true);
});

test("a finished plugin run is not busy", () => {
  for (const state of ["complete", "completed", "failed", "stopped", "aborted"]) {
    const fs = fakeFs(runSpec("run-1", activeRun({ state })));
    assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs }), false, state);
  }
});

test("a run past its own deadline, a dead pid, or another session is not busy", () => {
  const expired = fakeFs(runSpec("run-1", activeRun({ deadlineAt: NOW - 5 * 60 * 1000 })));
  assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs: expired }), false);

  const deadPid = fakeFs(runSpec("run-1", activeRun()));
  assert.equal(
    hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs: deadPid, pidAlive: () => false }),
    false,
  );

  const otherSession = fakeFs(runSpec("run-1", activeRun({ sessionId: "/sessions/other.jsonl", sessionRoot: "/sessions/other" })));
  assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs: otherSession }), false);
});

test("an unknown state with a live deadline stays busy (fail closed)", () => {
  const fs = fakeFs(runSpec("run-1", activeRun({ state: "warming-up" })));
  assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs }), true);
});

test("an unreadable registry or entry is skipped, never guessed at", () => {
  assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: "/tmp/absent", fs: fakeFs({}) }), false);
  const fs = fakeFs({
    [RUNS_DIR]: { children: ["run-1"], mtimeMs: NOW },
    [`${RUNS_DIR}/run-1`]: { children: ["status.json"], mtimeMs: NOW },
    [`${RUNS_DIR}/run-1/status.json`]: { content: "{not json", mtimeMs: NOW },
  });
  assert.equal(hasActivePluginRun({ sessionFile: SESSION_FILE, now: NOW, runsDir: RUNS_DIR, fs }), false);
});

test("the plugin registry is only consulted with a session file", () => {
  const fs = fakeFs(runSpec("run-1", activeRun()));
  assert.equal(hasActivePluginRun({ sessionId: "abc", now: NOW, runsDir: RUNS_DIR, fs }), false);
});

test("hasDelegatedWorkRunning combines both signals", () => {
  clearDelegatedWorkCache();
  const artifactOnly = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW },
  });
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, pluginRunsDir: null, fs: artifactOnly }),
    true,
  );

  clearDelegatedWorkCache();
  const registryOnly = fakeFs({
    ...runSpec("run-1", activeRun()),
  });
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, pluginRunsDir: RUNS_DIR, fs: registryOnly }),
    true,
  );

  clearDelegatedWorkCache();
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, pluginRunsDir: RUNS_DIR, fs: fakeFs({}) }),
    false,
  );
});

test("a child that went quiet is still caught by the registry", () => {
  clearDelegatedWorkCache();
  const fs = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW - 30 * 60 * 1000 },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW - 30 * 60 * 1000 },
    ...runSpec("run-1", activeRun()),
  });
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, pluginRunsDir: RUNS_DIR, fs }),
    true,
  );
});

test("answers are cached briefly and bypassCache re-reads", () => {
  clearDelegatedWorkCache();
  const fresh = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW - 60 * 60 * 1000 },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, pluginRunsDir: null, fs: fresh }), true);

  const stale = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW - 60 * 60 * 1000 },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW - 60 * 60 * 1000 },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + 1_000, windowMs: WINDOW, pluginRunsDir: null, fs: stale }), true);
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + 1_000, windowMs: WINDOW, pluginRunsDir: null, fs: stale, bypassCache: true }),
    false,
  );
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + DELEGATED_WORK_CACHE_TTL_MS + 1, windowMs: WINDOW, pluginRunsDir: null, fs: stale }),
    false,
  );
});

test("the activity window comes from the environment, clamped", () => {
  assert.equal(resolveDelegatedActivityWindowMs({}), DEFAULT_DELEGATED_ACTIVITY_WINDOW_MS);
  assert.equal(resolveDelegatedActivityWindowMs({ PI_WEB_DELEGATED_ACTIVITY_WINDOW_MS: "60000" }), 60_000);
  assert.equal(resolveDelegatedActivityWindowMs({ PI_WEB_DELEGATED_ACTIVITY_WINDOW_MS: "1" }), MIN_DELEGATED_ACTIVITY_WINDOW_MS);
  assert.equal(
    resolveDelegatedActivityWindowMs({ PI_WEB_DELEGATED_ACTIVITY_WINDOW_MS: String(24 * 60 * 60 * 1000) }),
    MAX_DELEGATED_ACTIVITY_WINDOW_MS,
  );
  assert.equal(resolveDelegatedActivityWindowMs({ PI_WEB_DELEGATED_ACTIVITY_WINDOW_MS: "nonsense" }), DEFAULT_DELEGATED_ACTIVITY_WINDOW_MS);
  assert.equal(resolveDelegatedActivityWindowMs({ PI_WEB_DELEGATED_ACTIVITY_WINDOW_MS: "0" }), DEFAULT_DELEGATED_ACTIVITY_WINDOW_MS);
});
