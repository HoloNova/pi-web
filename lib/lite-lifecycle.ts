// Pure decision rules for the Lite-mode session lifetime. The hook that wires
// these into the browser lives in hooks/useLiteSessionLifecycle.ts; keeping the
// rules here makes the default / configured idle cases testable without a DOM.

/** Idle minutes a mounted Lite page uses when nothing else is configured. */
export const DEFAULT_LITE_IDLE_MINUTES = 5;
/** Bounds of the device-local idle-minutes option, in whole minutes. */
export const MIN_LITE_IDLE_MINUTES = 1;
export const MAX_LITE_IDLE_MINUTES = 60;

/** The default idle window, in milliseconds. */
export const LITE_IDLE_PRESENCE_TIMEOUT_MS = DEFAULT_LITE_IDLE_MINUTES * 60 * 1000;

/**
 * Events that count as real user interaction. Heartbeats, the lease-renew
 * interval, SSE traffic, and state polling are deliberately absent.
 */
export const LITE_INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/** A whole number of minutes inside the supported range. */
export function isValidLiteIdleMinutes(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_LITE_IDLE_MINUTES
    && value <= MAX_LITE_IDLE_MINUTES;
}

export function liteIdleMinutesToMs(minutes: number): number {
  return minutes * 60_000;
}

/**
 * Parse a stored idle-minutes value. A missing, malformed, or out-of-range
 * value falls back to the default rather than clamping, so a corrupted entry
 * never silently changes the window.
 */
export function parseLiteIdleMinutes(raw: string | null): number {
  if (raw === null) return DEFAULT_LITE_IDLE_MINUTES;
  const value = Number(raw);
  return isValidLiteIdleMinutes(value) ? value : DEFAULT_LITE_IDLE_MINUTES;
}

export interface LitePresenceInput {
  /** Lite mode is on. Normal mode never holds or releases presence. */
  enabled: boolean;
  /** The page is still mounted and a session is selected. */
  mounted: boolean;
  /** Timestamp of the last real user interaction. */
  lastInteractionAt: number;
  /** Current time. */
  now: number;
  /** Idle window before this page releases, in milliseconds. */
  idleTimeoutMs: number;
}

/**
 * Whether this page should be holding a presence lease for its session.
 * Holding is what keeps the server wrapper warm; dropping it lets the wrapper
 * close once no other tab/device holds it and no task is running.
 *
 * Visibility is deliberately not an input: a mounted Lite page holds presence
 * while it is open and the last real interaction is within the idle deadline,
 * whether or not the page is visible on screen. Switching tabs, minimizing the
 * window, or switching applications therefore keeps the session warm, and
 * returning within the deadline needs no reload.
 */
export function shouldHoldLitePresence(input: LitePresenceInput): boolean {
  if (!input.enabled || !input.mounted) return false;
  if (!Number.isFinite(input.idleTimeoutMs) || input.idleTimeoutMs <= 0) return false;
  return input.now - input.lastInteractionAt < input.idleTimeoutMs;
}

/** Milliseconds until a page at `lastInteractionAt` should stop holding. */
export function liteIdleDeadlineIn(
  lastInteractionAt: number,
  now: number,
  idleTimeoutMs: number,
): number {
  return Math.max(0, idleTimeoutMs - (now - lastInteractionAt));
}
