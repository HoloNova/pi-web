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
  hasDelegatedWorkRunning,
  hasRecentArtifactActivity,
  resolveDelegatedActivityWindowMs,
  sessionArtifactDir,
} = await jiti.import("./delegated-work.ts");

const NOW = 1_800_000_000_000;
const WINDOW = 3 * 60 * 1000;
const ARTIFACT_DIR = "/tmp/pi-web-delegated-test/session-abc";
const SESSION_FILE = `${ARTIFACT_DIR}.jsonl`;
const OLD = NOW - 60 * 60 * 1000;

/** Minimal fs seam: keys are absolute paths, a `children` array marks a directory. */
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
  };
}

/** Wraps a fake fs and counts directory reads, so cache hits are observable. */
function countingFs(spec) {
  const fs = fakeFs(spec);
  let reads = 0;
  return {
    fs: {
      readdirSync(path) { reads += 1; return fs.readdirSync(path); },
      statSync(path) { return fs.statSync(path); },
    },
    reads: () => reads,
  };
}

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
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: ["run-0"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a/run-0`]: { children: ["session.jsonl"], mtimeMs: NOW - 1_000 },
    [`${ARTIFACT_DIR}/child-a/run-0/session.jsonl`]: { mtimeMs: OLD },
  });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), true);
});

test("artifact activity ignores old writes and a missing directory", () => {
  const fs = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: OLD },
  });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), false);
  assert.equal(hasRecentArtifactActivity("/tmp/pi-web-delegated-test/absent", { now: NOW, windowMs: WINDOW, fs }), false);
});

test("an unreadable artifact directory counts as busy", () => {
  const fs = fakeFs({ [ARTIFACT_DIR]: { deny: true, children: [] } });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), true);
});

test("a scan that hits the entry limit counts as busy", () => {
  // The rest of the tree was never read, so "no recent write" would be a guess:
  // a truncated scan reports busy rather than idle.
  const children = Array.from({ length: 700 }, (_, index) => `entry-${index}`);
  const spec = { [ARTIFACT_DIR]: { children, mtimeMs: OLD } };
  for (const child of children) spec[`${ARTIFACT_DIR}/${child}`] = { mtimeMs: OLD };
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs: fakeFs(spec) }), true);
});

test("a tree deeper than the scan limit counts as busy", () => {
  // `<session>/<child>/<run>/<extra>` is deeper than the scan descends; the level
  // below is unread, so the answer stays busy instead of guessing.
  const fs = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: ["run-0"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a/run-0`]: { children: ["extra"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a/run-0/extra`]: { children: ["deep"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a/run-0/extra/deep`]: { children: [], mtimeMs: OLD },
  });
  assert.equal(hasRecentArtifactActivity(ARTIFACT_DIR, { now: NOW, windowMs: WINDOW, fs }), true);
});

test("hasDelegatedWorkRunning reports recent child writes", () => {
  clearDelegatedWorkCache();
  const active = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs: active }), true);

  clearDelegatedWorkCache();
  const quiet = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: OLD },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs: quiet }), false);
});

test("a session without an artifact directory has no delegated work", () => {
  clearDelegatedWorkCache();
  const fs = fakeFs({});
  assert.equal(hasDelegatedWorkRunning({ sessionFile: "", now: NOW, windowMs: WINDOW, fs }), false);
  assert.equal(hasDelegatedWorkRunning({ sessionId: "abc", now: NOW, windowMs: WINDOW, fs }), false);
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, artifactDir: null, now: NOW, windowMs: WINDOW, fs }),
    false,
  );
});

test("answers are cached briefly and bypassCache re-reads", () => {
  clearDelegatedWorkCache();
  const fresh = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs: fresh }), true);

  const stale = fakeFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: OLD },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + 1_000, windowMs: WINDOW, fs: stale }), true);
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + 1_000, windowMs: WINDOW, fs: stale, bypassCache: true }),
    false,
  );
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + DELEGATED_WORK_CACHE_TTL_MS + 1, windowMs: WINDOW, fs: stale }),
    false,
  );
});

test("a busy answer is reused for the whole TTL, then measured again", () => {
  clearDelegatedWorkCache();
  const active = countingFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: NOW },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: NOW },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs: active.fs }), true);
  const measured = active.reads();
  assert.ok(measured > 0, "the first call reads the tree");

  // Inside the TTL the answer comes from the cache: no further directory reads,
  // even though the same tree is quiet by then.
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + DELEGATED_WORK_CACHE_TTL_MS - 1, windowMs: WINDOW, fs: active.fs }),
    true,
  );
  assert.equal(active.reads(), measured);

  const quiet = countingFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: OLD },
  });
  assert.equal(
    hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW + DELEGATED_WORK_CACHE_TTL_MS + 1, windowMs: WINDOW, fs: quiet.fs }),
    false,
  );
  assert.ok(quiet.reads() > 0, "the expired answer is measured again");
});

test("a quiet answer is never cached, so a child that starts later is seen at once", () => {
  clearDelegatedWorkCache();
  // Same instant, same tree object; only the file timestamps change, the way
  // they do when an external plugin's child starts writing seconds after an
  // idle probe. A cached quiet answer here would hide that child for the TTL.
  const spec = {
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: OLD },
  };
  const fs = fakeFs(spec);
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs }), false);

  spec[`${ARTIFACT_DIR}/child-a`].mtimeMs = NOW;
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs }), true);
  clearDelegatedWorkCache();
});

test("a quiet answer is measured again on the next call", () => {
  clearDelegatedWorkCache();
  const quiet = countingFs({
    [ARTIFACT_DIR]: { children: ["child-a"], mtimeMs: OLD },
    [`${ARTIFACT_DIR}/child-a`]: { children: [], mtimeMs: OLD },
  });
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs: quiet.fs }), false);
  const first = quiet.reads();
  assert.ok(first > 0);
  assert.equal(hasDelegatedWorkRunning({ sessionFile: SESSION_FILE, now: NOW, windowMs: WINDOW, fs: quiet.fs }), false);
  assert.ok(quiet.reads() > first, "the second call scans instead of reusing the quiet answer");
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
