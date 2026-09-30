import type { MemoryStatusResponse } from "@/lib/api-types";

/**
 * The status read measures the service, so polling it hard would create work for
 * an otherwise idle Pi-Web. Ten seconds keeps the readout current without a busy
 * loop, and polling pauses while the tab is hidden.
 */
export const MEMORY_STATUS_POLL_INTERVAL_MS = 10_000;

export interface MemoryStatusSnapshot {
  status: MemoryStatusResponse | null;
  error: string | null;
}

export type MemoryStatusListener = (snapshot: MemoryStatusSnapshot) => void;

export interface MemoryStatusSubscribeOptions {
  /**
   * Keep the shared poll loop alive while this subscriber is present. A
   * subscriber that only renders what it is handed leaves this false and never
   * keeps the loop alive on its own.
   */
  poll: boolean;
}

interface MemoryStatusSubscriber {
  listener: MemoryStatusListener;
  poll: boolean;
}

export const EMPTY_MEMORY_STATUS_SNAPSHOT: MemoryStatusSnapshot = { status: null, error: null };

// One snapshot per tab, shared by every surface: the settings control and the
// chat card read the same value and are notified together, so they cannot show
// different targets or different readings.
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
 * settings control and the poll tick never stack fetches.
 */
export function refreshMemoryStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch("/api/memory", { cache: "no-store" });
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
 * still receives every broadcast.
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
