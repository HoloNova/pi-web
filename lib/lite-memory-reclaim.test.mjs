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
  const deferred = [];
  const result = runIdleReclaimPass(
    [candidate("running", 10, { running: true }), candidate("viewed", 20, { viewed: true })],
    { reclaim: (id) => { reclaimed.push(id); return true; }, defer: (id) => deferred.push(id) },
  );
  assert.deepEqual(result, { reclaimed: [], reclaimable: 0, running: 1, viewed: 1 });
  assert.deepEqual(reclaimed, []);
  // A viewed wrapper is left completely alone; only a running, unviewed one is
  // marked so it closes once the run settles.
  assert.deepEqual(deferred, ["running"]);
});

test("a pass reclaims idle wrappers oldest first and marks running ones", () => {
  const order = [];
  const deferred = [];
  const result = runIdleReclaimPass([
    candidate("running", 5, { running: true }),
    candidate("third", 30),
    candidate("first", 10),
    candidate("second", 20),
  ], {
    reclaim: (id) => { order.push(id); return true; },
    defer: (id) => deferred.push(id),
  });
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.deepEqual(result.reclaimed, ["first", "second", "third"]);
  assert.equal(result.reclaimable, 3);
  assert.equal(result.running, 1);
  assert.deepEqual(deferred, ["running"]);
});

test("a reclaim that does not start its shutdown is not reported as reclaimed", () => {
  const result = runIdleReclaimPass([candidate("idle", 10)], {
    reclaim: () => false,
    defer: () => {},
  });
  assert.deepEqual(result.reclaimed, []);
  assert.equal(result.reclaimable, 1);
});
