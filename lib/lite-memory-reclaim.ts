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
 * stable across calls. A wrapper that is running or has another live viewer is
 * never in `reclaim`: closing it would cut a turn or tool call short, or pull a
 * session out from under a page that is still looking at it.
 */
export function planIdleReclaim(candidates: readonly ReclaimCandidate[]): ReclaimPlan {
  const ordered = [...candidates].sort(
    (a, b) => a.lastActivityAt - b.lastActivityAt || a.sessionId.localeCompare(b.sessionId),
  );
  const reclaim: string[] = [];
  const deferred: string[] = [];
  for (const candidate of ordered) {
    if (candidate.running || candidate.viewed) deferred.push(candidate.sessionId);
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
}

export interface ReclaimPassHooks {
  /** Ask the server to close an idle, unviewed wrapper; true if shutdown started. */
  reclaim(sessionId: string): boolean;
  /** Mark a running, unviewed wrapper so it closes once the run settles. */
  defer(sessionId: string): void;
}

/**
 * Run one pressure pass over the given candidates. Only idle, unviewed wrappers
 * are asked to close; a running but unviewed wrapper is marked and reclaimed
 * after it settles. A viewed wrapper is left completely untouched. When nothing
 * is reclaimable the pass closes nothing and reports the counts, which is how
 * an over-target service stays over target instead of escalating.
 */
export function runIdleReclaimPass(
  candidates: readonly ReclaimCandidate[],
  hooks: ReclaimPassHooks,
): ReclaimPassResult {
  const plan = planIdleReclaim(candidates);
  const reclaimed: string[] = [];
  for (const sessionId of plan.reclaim) {
    if (hooks.reclaim(sessionId)) reclaimed.push(sessionId);
  }
  for (const sessionId of plan.deferred) {
    const candidate = candidates.find((entry) => entry.sessionId === sessionId);
    // A viewed wrapper is left alone: milestone-1 presence release already
    // handles it, and closing it here would surprise an active viewer.
    if (candidate?.running && !candidate.viewed) hooks.defer(sessionId);
  }
  return {
    reclaimed,
    reclaimable: plan.reclaim.length,
    running: candidates.filter((candidate) => candidate.running).length,
    viewed: candidates.filter((candidate) => candidate.viewed).length,
  };
}
