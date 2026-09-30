// Pure decision rules for the Lite session lifetime. The hook that wires these
// into the browser lives in hooks/useLiteSessionLifecycle.ts; keeping the rules
// here makes the idle cases testable without a DOM.
//
// The idle window itself comes from the instance's Lite configuration
// (lib/lite-config.ts) — it is a server-wide setting, not a per-device one.

/**
 * Events that count as real user interaction. Heartbeats, the lease-renew
 * interval, SSE traffic, and state polling are deliberately absent: none of
 * them means somebody is still using the page.
 */
export const LITE_INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

export function liteIdleMinutesToMs(minutes: number): number {
  return minutes * 60_000;
}

export interface LitePresenceInput {
  /** Lite mode is on for this instance. Normal mode never holds presence. */
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
 * close once no other tab or device holds the session and nothing is running.
 *
 * Visibility is deliberately not an input: a mounted Lite page holds presence
 * while it is open and the last real interaction is within the idle deadline,
 * whether or not the page is on screen. Switching tabs, minimizing the window,
 * or switching applications therefore keeps the session warm, and returning
 * within the deadline needs no reload.
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
