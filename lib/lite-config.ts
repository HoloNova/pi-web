/**
 * Lite mode's configuration: what Pi-Web stores about it, the bounds every
 * value is validated against, and the defaults a fresh install starts from.
 *
 * Lite mode belongs to the running Pi-Web instance, not to a browser profile.
 * It decides which model catalogue is loaded, how long an idle session is kept
 * warm, and how much memory the service aims to stay under — all shared server
 * resources — so every device that reaches this instance reads the same mode.
 * This module is pure; the settings file itself is read and written by
 * lib/lite-config-settings.ts.
 */

export interface LiteConfig {
  /** Whether this Pi-Web instance runs the reduced-resource policy. */
  enabled: boolean;
  /** Minutes without real interaction before an idle page releases its session. */
  idleMinutes: number;
  /** Soft target for Pi-Web's own memory, in MiB. */
  memoryTargetMiB: number;
}

export interface LiteValueBounds {
  min: number;
  max: number;
  /** What a fresh install starts from. */
  default: number;
}

/** Bounds travel with every read so a client can validate before it saves. */
export interface LiteConfigBounds {
  idleMinutes: LiteValueBounds;
  memoryTargetMiB: LiteValueBounds;
}

export const MIN_LITE_IDLE_MINUTES = 1;
export const MAX_LITE_IDLE_MINUTES = 60;
export const DEFAULT_LITE_IDLE_MINUTES = 5;
export const MIN_MEMORY_TARGET_MIB = 256;
export const MAX_MEMORY_TARGET_MIB = 16384;
export const DEFAULT_MEMORY_TARGET_MIB = 1800;

/** The bounds and the starting point, sent with every read. */
export const LITE_CONFIG_BOUNDS: LiteConfigBounds = {
  idleMinutes: { min: MIN_LITE_IDLE_MINUTES, max: MAX_LITE_IDLE_MINUTES, default: DEFAULT_LITE_IDLE_MINUTES },
  memoryTargetMiB: { min: MIN_MEMORY_TARGET_MIB, max: MAX_MEMORY_TARGET_MIB, default: DEFAULT_MEMORY_TARGET_MIB },
};

export const DEFAULT_LITE_CONFIG: LiteConfig = {
  enabled: false,
  idleMinutes: DEFAULT_LITE_IDLE_MINUTES,
  memoryTargetMiB: DEFAULT_MEMORY_TARGET_MIB,
};

function isWholeNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function isValidLiteIdleMinutes(value: unknown): value is number {
  return isWholeNumberInRange(value, MIN_LITE_IDLE_MINUTES, MAX_LITE_IDLE_MINUTES);
}

export function isValidMemoryTargetMiB(value: unknown): value is number {
  return isWholeNumberInRange(value, MIN_MEMORY_TARGET_MIB, MAX_MEMORY_TARGET_MIB);
}

/**
 * A complete configuration from whatever the settings file happened to hold.
 * Anything missing or outside its bounds falls back to the default: the values
 * are policy, so a hand-edited or older file must never make a read fail.
 */
export function coerceLiteConfig(stored: unknown): LiteConfig {
  const record = stored !== null && typeof stored === "object" && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_LITE_CONFIG.enabled,
    idleMinutes: isValidLiteIdleMinutes(record.idleMinutes) ? record.idleMinutes : DEFAULT_LITE_CONFIG.idleMinutes,
    memoryTargetMiB: isValidMemoryTargetMiB(record.memoryTargetMiB)
      ? record.memoryTargetMiB
      : DEFAULT_LITE_CONFIG.memoryTargetMiB,
  };
}
