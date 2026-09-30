// Pure policy for Pi-Web's service-wide memory target. The target is a SOFT
// threshold owned by Pi-Web: reaching it makes Lite mode reclaim the oldest
// idle sessions. It never changes the service's systemd MemoryHigh/MemoryMax
// guardrails, which stay the real limit, and it never causes a process kill.

export const MEMORY_BYTES_PER_MIB = 1024 * 1024;

/**
 * Usage at or above this fraction of the target is reported as "near". The
 * warning starts before the target is crossed so Lite mode has room to reclaim
 * idle sessions.
 */
export const MEMORY_NEAR_TARGET_RATIO = 0.9;

export type MemoryPressureState = "ok" | "near" | "over";

/**
 * Strictly "over" once usage exceeds the target and "near" from 90% of it up to
 * the target. A non-finite or non-positive input reports "ok" rather than a
 * bogus warning.
 */
export function memoryPressureState(
  usedBytes: number,
  targetMiB: number,
  nearRatio: number = MEMORY_NEAR_TARGET_RATIO,
): MemoryPressureState {
  const targetBytes = targetMiB * MEMORY_BYTES_PER_MIB;
  if (!Number.isFinite(usedBytes) || usedBytes < 0 || !Number.isFinite(targetBytes) || targetBytes <= 0) {
    return "ok";
  }
  if (usedBytes > targetBytes) return "over";
  if (usedBytes >= targetBytes * nearRatio) return "near";
  return "ok";
}

/** Whether a pressure state asks Lite mode to reclaim idle sessions. */
export function shouldReclaimForMemoryState(state: MemoryPressureState): boolean {
  return state !== "ok";
}
