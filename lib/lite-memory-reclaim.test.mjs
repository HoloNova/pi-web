import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { planIdleReclaim, runIdleReclaimPass } = await jiti.import("./lite-memory-reclaim.ts");

const candidate = (sessionId, lastActivityAt, extra = {}) => ({
  sessionId,
  lastActivityAt,
  running: false,
  viewed: false,
  ...extra,
});

test("orders reclaimable wrappers oldest first by last real activity", () => {
  const plan = planIdleReclaim([
    candidate("newest", 300),
    candidate("oldest", 100),
    candidate("middle", 200),
  ]);
  assert.deepEqual(plan.reclaim, ["oldest", "middle", "newest"]);
  assert.deepEqual(plan.deferred, []);
});

test("ties break on session id so the order is stable", () => {
  const plan = planIdleReclaim([
    candidate("b", 100),
    candidate("a", 100),
    candidate("c", 100),
  ]);
  assert.deepEqual(plan.reclaim, ["a", "b", "c"]);
});

test("a running or viewed wrapper is deferred, never reclaimed", () => {
  const plan = planIdleReclaim([
    candidate("idle", 100),
    candidate("running", 50, { running: true }),
    candidate("viewed", 25, { viewed: true }),
  ]);
  assert.deepEqual(plan.reclaim, ["idle"]);
  assert.deepEqual(plan.deferred, ["viewed", "running"]);
});

test("a pass with nothing reclaimable closes nothing and reports the counts", () => {
  const reclaimed = [];
  const result = runIdleReclaimPass(
    [candidate("running", 10, { running: true }), candidate("viewed", 20, { viewed: true })],
    { reclaim: (id) => { reclaimed.push(id); return true; } },
  );
  assert.deepEqual(result, { reclaimed: [], reclaimable: 0, running: 1, viewed: 1, delegated: 0 });
  // Neither a running task nor a session another page is viewing is closed, and
  // neither is armed: the next pass reconsiders them from current state.
  assert.deepEqual(reclaimed, []);
});

test("a pass closes the oldest idle wrapper and leaves the rest for later passes", () => {
  const order = [];
  const result = runIdleReclaimPass([
    candidate("running", 5, { running: true }),
    candidate("third", 30),
    candidate("first", 10),
    candidate("second", 20),
  ], { reclaim: (id) => { order.push(id); return true; } });
  // One per pass: the caller polls, and each pass takes the next-oldest one, so
  // a single over-target reading never drops a page's whole working set.
  assert.deepEqual(order, ["first"]);
  assert.deepEqual(result.reclaimed, ["first"]);
  assert.equal(result.reclaimable, 3);
  assert.equal(result.running, 1);
});

test("a pass with a larger limit closes that many, oldest first", () => {
  const order = [];
  const result = runIdleReclaimPass([
    candidate("third", 30),
    candidate("first", 10),
    candidate("second", 20),
  ], { reclaim: (id) => { order.push(id); return true; } }, { limit: 3 });
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.deepEqual(result.reclaimed, ["first", "second", "third"]);
  assert.equal(result.reclaimable, 3);
});

test("a reclaim that does not start its shutdown is not reported as reclaimed", () => {
  const result = runIdleReclaimPass([candidate("idle", 10)], {
    reclaim: () => false,
  });
  assert.deepEqual(result.reclaimed, []);
  assert.equal(result.reclaimable, 1);
});

test("a wrapper with delegated work is left for a later pass, never reclaimed", () => {
  const reclaimed = [];
  const result = runIdleReclaimPass([
    candidate("idle", 100),
    candidate("child-running", 10, { delegated: true }),
  ], { reclaim: (id) => { reclaimed.push(id); return true; } });
  assert.deepEqual(reclaimed, ["idle"]);
  assert.deepEqual(result.reclaimed, ["idle"]);
  assert.equal(result.reclaimable, 1);
  assert.equal(result.delegated, 1);
});

test("delegated work on a viewed wrapper leaves it completely untouched", () => {
  const reclaimed = [];
  const deferred = [];
  const result = runIdleReclaimPass([candidate("both", 10, { delegated: true, viewed: true })], {
    reclaim: (id) => { reclaimed.push(id); return true; },
    defer: (id) => deferred.push(id),
  });
  assert.deepEqual(reclaimed, []);
  assert.deepEqual(deferred, []);
  assert.equal(result.delegated, 1);
  assert.equal(result.viewed, 1);
});
