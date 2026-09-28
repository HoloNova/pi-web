import {
  MEMORY_BYTES_PER_MIB,
  memoryPressureState,
} from "@/lib/memory-target";
import { liteModeRequestHeaders } from "@/lib/lite-request";
import type {
  MemoryStatusActiveResponse,
  MemoryStatusResponse,
  MemoryTargetResponse,
} from "@/lib/api-types";

/**
 * The status read is deliberately slow. It measures the service and, in Lite
 * mode, runs a bounded idle-session reclaim pass, so polling it hard would
 * create work for an otherwise idle Pi-Web. Ten seconds keeps the readout
 * current without a busy loop, and polling pauses while the tab is hidden.
 */
export const MEMORY_STATUS_POLL_INTERVAL_MS = 10_000;

export interface MemoryStatusSnapshot {
  status: MemoryStatusResponse | null;
  error: string | null;
}

export type MemoryStatusListener = (snapshot: MemoryStatusSnapshot) => void;

export interface MemoryStatusSubscribeOptions {
  /**
   * Keep the shared 10 s poll loop alive while this subscriber is present. A
   * subscriber that only needs the value it is handed (and the broadcast after
   * a save) leaves this false and never keeps the loop alive on its own.
   */
  poll: boolean;
}

interface MemoryStatusSubscriber {
  listener: MemoryStatusListener;
  poll: boolean;
}

export const EMPTY_MEMORY_STATUS_SNAPSHOT: MemoryStatusSnapshot = { status: null, error: null };

// One snapshot per tab, shared by every surface. MemoryTargetControl and the
// chat card used to hold independent copies, so the settings panel could show
// a target the chat had already replaced. They now read this one value and are
// notified together.
let snapshot: MemoryStatusSnapshot = EMPTY_MEMORY_STATUS_SNAPSHOT;
const subscribers = new Set<MemoryStatusSubscriber>();
let inFlight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let visibilityAttached = false;

function emit(): void {
  const current = snapshot;
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.listener(current);
    } catch (error) {
      console.error(
        "[pi-web] memory status listener failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

function setSnapshot(status: MemoryStatusResponse | null, error: string | null): void {
  if (snapshot.status === status && snapshot.error === error) return;
  snapshot = { status, error };
  emit();
}

export function getMemoryStatusSnapshot(): MemoryStatusSnapshot {
  return snapshot;
}

/**
 * Read once. Concurrent callers share a single request: the chat card, the
 * settings control, the poll tick, and a save's reconcile never stack fetches.
 */
export function refreshMemoryStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch("/api/memory", {
        headers: liteModeRequestHeaders(),
        cache: "no-store",
      });
      const data = await response.json() as MemoryStatusResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSnapshot(data, null);
    } catch (cause) {
      setSnapshot(snapshot.status, cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Merge a saved target into the snapshot and notify every subscriber before the
 * reconcile request returns. `usedBytes` and `state` are recomputed from the
 * last reading so the new target is reflected immediately; the reconcile pass
 * then replaces the reading with the authoritative one.
 */
function applySavedTarget(target: MemoryTargetResponse): void {
  const previous: MemoryStatusActiveResponse | null = snapshot.status?.active ? snapshot.status : null;
  const usedBytes = previous?.usedBytes ?? 0;
  const status: MemoryStatusActiveResponse = {
    active: true,
    targetMiB: target.targetMiB,
    defaultMiB: target.defaultMiB,
    minMiB: target.minMiB,
    maxMiB: target.maxMiB,
    nearRatio: target.nearRatio,
    usedBytes,
    usedMiB: Math.round(usedBytes / MEMORY_BYTES_PER_MIB),
    state: memoryPressureState(usedBytes, target.targetMiB, target.nearRatio),
    source: previous?.source ?? "process-rss",
    approximate: previous?.approximate ?? false,
    detail: previous?.detail ?? "",
    reclaim: previous?.reclaim ?? null,
  };
  setSnapshot(status, null);
}

/**
 * Persist a new service-wide target. Only a Lite tab reaches this — the route
 * refuses the write without the Lite header — and a successful save broadcasts
 * the new target to every subscriber right away, then reconciles the reading.
 */
export async function putMemoryTarget(targetMiB: number): Promise<MemoryTargetResponse> {
  const response = await fetch("/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...liteModeRequestHeaders() },
    body: JSON.stringify({ targetMiB }),
  });
  const data = await response.json() as MemoryTargetResponse & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  applySavedTarget(data);
  void refreshMemoryStatus();
  return data;
}

function wantsPoll(): boolean {
  for (const subscriber of subscribers) {
    if (subscriber.poll) return true;
  }
  return false;
}

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function reconcilePollLoop(): void {
  const shouldPoll = subscribers.size > 0 && wantsPoll() && documentVisible();
  if (shouldPoll) {
    if (!pollTimer) {
      pollTimer = setInterval(() => { void refreshMemoryStatus(); }, MEMORY_STATUS_POLL_INTERVAL_MS);
    }
    return;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function onVisibilityChange(): void {
  if (documentVisible()) void refreshMemoryStatus();
  reconcilePollLoop();
}

function attachVisibilityListener(): void {
  if (visibilityAttached || typeof document === "undefined") return;
  if (typeof document.addEventListener !== "function") return;
  document.addEventListener("visibilitychange", onVisibilityChange);
  visibilityAttached = true;
}

function detachVisibilityListener(): void {
  if (!visibilityAttached || subscribers.size > 0) return;
  visibilityAttached = false;
  if (typeof document === "undefined" || typeof document.removeEventListener !== "function") return;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

/**
 * Subscribe to the shared snapshot. The first polling subscriber starts the one
 * shared poll loop; the last one to leave stops it. A non-polling subscriber
 * still receives every broadcast, including the one a save emits.
 */
export function subscribeMemoryStatus(
  listener: MemoryStatusListener,
  options: MemoryStatusSubscribeOptions = { poll: false },
): () => void {
  const subscriber: MemoryStatusSubscriber = { listener, poll: options.poll === true };
  subscribers.add(subscriber);
  attachVisibilityListener();
  reconcilePollLoop();
  return () => {
    subscribers.delete(subscriber);
    reconcilePollLoop();
    detachVisibilityListener();
  };
}
