import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  DEFAULT_MEMORY_TARGET_MIB,
  MAX_MEMORY_TARGET_MIB,
  MEMORY_BYTES_PER_MIB,
  MEMORY_NEAR_TARGET_RATIO,
  MIN_MEMORY_TARGET_MIB,
  isValidMemoryTargetMiB,
  memoryPressureState,
  shouldReclaimForMemoryState,
} = await jiti.import("./memory-target.ts");

const targetMiB = 1000;
const at = (mib) => mib * MEMORY_BYTES_PER_MIB;

test("the default target sits on the service's soft systemd limit", () => {
  assert.equal(DEFAULT_MEMORY_TARGET_MIB, 1500);
  assert.ok(MIN_MEMORY_TARGET_MIB < DEFAULT_MEMORY_TARGET_MIB);
  assert.ok(MAX_MEMORY_TARGET_MIB > DEFAULT_MEMORY_TARGET_MIB);
});

test("pressure state is ok below 90%, near up to the target and over past it", () => {
  assert.equal(MEMORY_NEAR_TARGET_RATIO, 0.9);
  assert.equal(memoryPressureState(at(899), targetMiB), "ok");
  assert.equal(memoryPressureState(at(900), targetMiB), "near");
  assert.equal(memoryPressureState(at(999), targetMiB), "near");
  assert.equal(memoryPressureState(at(1000), targetMiB), "near");
  assert.equal(memoryPressureState(at(1001), targetMiB), "over");
});

test("only a real pressure state asks for reclaim", () => {
  assert.equal(shouldReclaimForMemoryState("ok"), false);
  assert.equal(shouldReclaimForMemoryState("near"), true);
  assert.equal(shouldReclaimForMemoryState("over"), true);
});

test("bogus usage reports ok rather than a false warning", () => {
  assert.equal(memoryPressureState(Number.NaN, targetMiB), "ok");
  assert.equal(memoryPressureState(Number.POSITIVE_INFINITY, targetMiB), "ok");
  assert.equal(memoryPressureState(-1, targetMiB), "ok");
  assert.equal(memoryPressureState(at(1200), 0), "ok");
});

test("the target is a whole number inside the supported range", () => {
  assert.equal(isValidMemoryTargetMiB(MIN_MEMORY_TARGET_MIB), true);
  assert.equal(isValidMemoryTargetMiB(MAX_MEMORY_TARGET_MIB), true);
  assert.equal(isValidMemoryTargetMiB(1500), true);
  for (const invalid of [MIN_MEMORY_TARGET_MIB - 1, MAX_MEMORY_TARGET_MIB + 1, 1500.5, "1500", null, undefined, Number.NaN]) {
    assert.equal(isValidMemoryTargetMiB(invalid), false, String(invalid));
  }
});
