// Pure decision rules for the Lite-mode session lifetime. The hook that wires
// these into the browser lives in hooks/useLiteSessionLifecycle.ts; keeping the
// rules here makes the 5-minute / disabled cases testable without a DOM.

/** A mounted Lite page stops renewing its presence after this much real idle. */
export const LITE_IDLE_PRESENCE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Events that count as real user interaction. Heartbeats, the lease-renew
 * interval, SSE traffic, and state polling are deliberately absent.
 */
export const LITE_INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

export interface LitePresenceInput {
  /** Lite mode is on. Normal mode never holds or releases presence. */
  enabled: boolean;
  /** The page is still mounted and a session is selected. */
  mounted: boolean;
  /** Timestamp of the last real user interaction. */
  lastInteractionAt: number;
  /** Current time. */
  now: number;
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
  return input.now - input.lastInteractionAt < LITE_IDLE_PRESENCE_TIMEOUT_MS;
}

/** Milliseconds until a page at `lastInteractionAt` should stop holding. */
export function liteIdleDeadlineIn(lastInteractionAt: number, now: number): number {
  return Math.max(0, LITE_IDLE_PRESENCE_TIMEOUT_MS - (now - lastInteractionAt));
}
