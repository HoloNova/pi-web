import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, interopDefault: true, moduleCache: false });
const {
  MEMORY_MONITOR_INTERVAL_MS,
  isLiteMemoryMonitorRunning,
  runLiteMemoryMonitorTick,
  startLiteMemoryMonitor,
} = await jiti.import("./lite-memory-monitor.ts");

const MiB = 1024 * 1024;

/** Dependency set that records what the policy actually touched. */
function deps({ enabled = true, targetMiB = 1800, usedBytes = 0, pass } = {}) {
  const calls = { liteConfig: 0, readMemory: 0, reclaim: 0 };
  const logs = [];
  return {
    calls,
    logs,
    deps: {
      liteConfig() { calls.liteConfig += 1; return { enabled, memoryTargetMiB: targetMiB }; },
      readMemory() { calls.readMemory += 1; return { bytes: usedBytes }; },
      state: (bytes, target) => {
        if (bytes > target * MiB) return "over";
        if (bytes >= target * MiB * 0.9) return "near";
        return "ok";
      },
      reclaim() {
        calls.reclaim += 1;
        return pass ?? { reclaimed: ["oldest"], reclaimable: 1, running: 0, viewed: 0, delegated: 0 };
      },
      log(message) { logs.push(message); },
    },
  };
}

/** Replaces the interval APIs so a start is observable without real time. */
function installFakeTimers() {
  const created = [];
  const cleared = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const handle = {
      ms,
      unrefCalled: false,
      unref() { this.unrefCalled = true; return this; },
    };
    handle.fire = () => fn();
    created.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { cleared.push(handle); };
  return {
    created,
    cleared,
    fire: (index = 0) => created[index].fire(),
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
}

test("Lite mode off: nothing is measured and nothing is closed", () => {
  const { deps: d, calls } = deps({ enabled: false });
  assert.equal(runLiteMemoryMonitorTick(d), "disabled");
  assert.equal(calls.readMemory, 0, "the target only exists in Lite mode");
  assert.equal(calls.reclaim, 0);
});

test("below the target a tick only measures", () => {
  const { deps: d, calls, logs } = deps({ usedBytes: 500 * MiB });
  assert.equal(runLiteMemoryMonitorTick(d), "below-target");
  assert.equal(calls.readMemory, 1);
  // No session is looked at: the walk over sessions and delegated trees lives
  // inside the reclaim pass, which a quiet reading must not reach.
  assert.equal(calls.reclaim, 0);
  assert.deepEqual(logs, []);
});

test("at or above the target a tick runs exactly one pass", () => {
  for (const usedBytes of [1800 * MiB, 2400 * MiB]) {
    const { deps: d, calls, logs } = deps({ usedBytes });
    assert.equal(runLiteMemoryMonitorTick(d), "reclaimed");
    assert.equal(calls.reclaim, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /closed 1 idle session/);
  }
});

test("a pass that closed nothing does not escalate", () => {
  const { deps: d, calls } = deps({
    usedBytes: 2400 * MiB,
    pass: { reclaimed: [], reclaimable: 0, running: 2, viewed: 0, delegated: 1 },
  });
  assert.equal(runLiteMemoryMonitorTick(d), "nothing-to-close");
  // One pass per tick, whatever it found: staying over target is the honest
  // outcome, and the next tick re-measures instead of escalating.
  assert.equal(calls.reclaim, 1);
});

test("the next tick stops once the reading is back below the target", () => {
  let usedBytes = 2400 * MiB;
  const { deps: d, calls } = deps();
  const withReading = { ...d, readMemory: () => ({ bytes: usedBytes }) };

  assert.equal(runLiteMemoryMonitorTick(withReading), "reclaimed");
  usedBytes = 900 * MiB;
  assert.equal(runLiteMemoryMonitorTick(withReading), "below-target");
  assert.equal(calls.reclaim, 1, "the reclaimed session is enough for the next tick to stop");
});

test("starting twice keeps one interval, and stopping clears it", () => {
  const timers = installFakeTimers();
  const { deps: d, logs } = deps({ usedBytes: 2400 * MiB });
  try {
    const stop = startLiteMemoryMonitor({ intervalMs: 1000, deps: d, log: (m) => logs.push(m) });
    assert.equal(timers.created.length, 1);
    assert.equal(timers.created[0].ms, 1000);
    assert.equal(isLiteMemoryMonitorRunning(), true);
    assert.match(logs.join("\n"), /monitor started, every 1s/);

    const secondStop = startLiteMemoryMonitor({ intervalMs: 1000, deps: d, log: (m) => logs.push(m) });
    assert.equal(timers.created.length, 1, "a second start must not add a second interval");
    assert.match(logs.join("\n"), /already running/);
    secondStop();

    stop();
    assert.equal(timers.cleared.length, 1);
    assert.equal(isLiteMemoryMonitorRunning(), false);
  } finally {
    timers.restore();
  }
});

test("the timer never holds the process open", () => {
  const timers = installFakeTimers();
  try {
    const stop = startLiteMemoryMonitor({ deps: deps().deps, log: () => {} });
    assert.equal(timers.created[0].unrefCalled, true);
    stop();
  } finally {
    timers.restore();
  }
});

test("the interval default is the documented one", () => {
  assert.equal(MEMORY_MONITOR_INTERVAL_MS, 15_000);
});

test("a failing pass is logged and the next tick tries again", () => {
  const timers = installFakeTimers();
  const logs = [];
  let attempts = 0;
  const failing = {
    ...deps({ usedBytes: 2400 * MiB }).deps,
    reclaim() {
      attempts += 1;
      throw new Error("registry unavailable");
    },
  };
  try {
    const stop = startLiteMemoryMonitor({ intervalMs: 1000, deps: failing, log: (m) => logs.push(m) });
    timers.fire();
    assert.equal(attempts, 1);
    assert.match(logs.join("\n"), /tick failed: registry unavailable/);
    timers.fire();
    assert.equal(attempts, 2, "a failed tick must not stop the policy");
    stop();
  } finally {
    timers.restore();
  }
});
