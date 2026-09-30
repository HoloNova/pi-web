// LRU planning for Lite mode's memory-pressure reclaim. When the service is
// near or over its memory target, the server asks which session wrappers may be
// closed; this module only orders and classifies them, so the policy is
// testable without a real AgentSession.

export interface ReclaimCandidate {
  sessionId: string;
  /** Epoch ms of the session's last real activity; smaller is older. */
  lastActivityAt: number;
  /** A turn, tool call, compaction or shell command is in flight. */
  running: boolean;
  /**
   * Delegated children (async subagent runs) are still working underneath this
   * session. The parent turn has already returned, so `running` is false and
   * only this flag protects the child from being killed with its wrapper.
   */
  delegated?: boolean;
  /** Another tab/device still holds this session (presence or an SSE stream). */
  viewed: boolean;
}

export interface ReclaimPlan {
  /** Oldest-first wrappers that can be reassessed for reclaim right now. */
  reclaim: string[];
  /** Oldest-first wrappers that must wait for a run to settle or a viewer to leave. */
  deferred: string[];
}

/**
 * Oldest first by last real activity; ties break on session id so the order is
 * stable across calls. A wrapper that is running, has delegated work in flight,
 * or has another live viewer is never in `reclaim`: closing it would cut a turn
 * or a child run short, or pull a session out from under a page that is still
 * looking at it.
 */
export function planIdleReclaim(candidates: readonly ReclaimCandidate[]): ReclaimPlan {
  const ordered = [...candidates].sort(
    (a, b) => a.lastActivityAt - b.lastActivityAt || a.sessionId.localeCompare(b.sessionId),
  );
  const reclaim: string[] = [];
  const deferred: string[] = [];
  for (const candidate of ordered) {
    if (candidate.running || candidate.viewed || candidate.delegated) deferred.push(candidate.sessionId);
    else reclaim.push(candidate.sessionId);
  }
  return { reclaim, deferred };
}

export interface ReclaimPassResult {
  /** Session ids whose shutdown was started, oldest first. */
  reclaimed: string[];
  /** Idle, unviewed wrappers found this pass (regardless of the reclaim outcome). */
  reclaimable: number;
  /** Running wrappers seen (skipped, their reclaim waits for the run to settle). */
  running: number;
  /** Wrappers held by another tab/device (skipped entirely). */
  viewed: number;
  /** Wrappers with delegated children still working (waits for the child to finish). */
  delegated: number;
}

export interface ReclaimPassHooks {
  /** Ask the server to close an idle, unviewed wrapper; true if shutdown started. */
  reclaim(sessionId: string): boolean;
}

/**
 * How many sessions one pass may close. Memory pressure is relieved a little at
 * a time on purpose: a single pass that closed every idle session would drop
 * work the next request is about to read, and the caller polls, so the next
 * pass takes the next-oldest one.
 */
export const RECLAIM_PASS_LIMIT = 1;

/**
 * Run one pressure pass over the given candidates. Only idle, unviewed
 * wrappers are asked to close, oldest first, and at most `limit` of them; a
 * running or delegated wrapper is left for the next pass to reconsider once it
 * settles, and a viewed wrapper is not touched at all. When nothing is
 * reclaimable the pass closes nothing and reports the counts, which is how an
 * over-target service stays over target instead of escalating.
 */
export function runIdleReclaimPass(
  candidates: readonly ReclaimCandidate[],
  hooks: ReclaimPassHooks,
  options: { limit?: number } = {},
): ReclaimPassResult {
  const limit = Math.max(0, options.limit ?? RECLAIM_PASS_LIMIT);
  const plan = planIdleReclaim(candidates);
  const reclaimed: string[] = [];
  for (const sessionId of plan.reclaim) {
    if (reclaimed.length >= limit) break;
    if (hooks.reclaim(sessionId)) reclaimed.push(sessionId);
  }
  return {
    reclaimed,
    reclaimable: plan.reclaim.length,
    running: candidates.filter((candidate) => candidate.running).length,
    viewed: candidates.filter((candidate) => candidate.viewed).length,
    delegated: candidates.filter((candidate) => candidate.delegated).length,
  };
}
