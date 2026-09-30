import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  MEMORY_BYTES_PER_MIB,
  MEMORY_NEAR_TARGET_RATIO,
  memoryPressureState,
  shouldReclaimForMemoryState,
} = await jiti.import("./memory-pressure.ts");
const { DEFAULT_MEMORY_TARGET_MIB, MAX_MEMORY_TARGET_MIB, MIN_MEMORY_TARGET_MIB } =
  await jiti.import("./lite-config.ts");

const MiB = MEMORY_BYTES_PER_MIB;

test("the target's bounds and default come from the Lite configuration", () => {
  // One setting, one place: the memory endpoints read the number the Lite
  // settings file already stores, so the two can never disagree.
  assert.equal(DEFAULT_MEMORY_TARGET_MIB, 1800);
  assert.equal(MIN_MEMORY_TARGET_MIB, 256);
  assert.equal(MAX_MEMORY_TARGET_MIB, 16384);
});

test("usage is near from 90% of the target and over only past it", () => {
  const target = 1800;
  assert.equal(memoryPressureState(target * MiB - 1, target), "near");
  assert.equal(memoryPressureState(target * MiB, target), "near");
  assert.equal(memoryPressureState(target * MiB + 1, target), "over");
  assert.equal(memoryPressureState(Math.floor(target * MiB * MEMORY_NEAR_TARGET_RATIO), target), "near");
  assert.equal(memoryPressureState(Math.floor(target * MiB * MEMORY_NEAR_TARGET_RATIO) - 1, target), "ok");
  assert.equal(memoryPressureState(0, target), "ok");
});

test("a nonsense reading reports ok instead of a bogus warning", () => {
  assert.equal(memoryPressureState(Number.NaN, 1800), "ok");
  assert.equal(memoryPressureState(-1, 1800), "ok");
  assert.equal(memoryPressureState(1024 * 1024, 0), "ok");
});

test("only a near or over state asks for a reclaim", () => {
  assert.equal(shouldReclaimForMemoryState("ok"), false);
  assert.equal(shouldReclaimForMemoryState("near"), true);
  assert.equal(shouldReclaimForMemoryState("over"), true);
});
