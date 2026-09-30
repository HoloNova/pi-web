"use client";

import { useEffect, useState } from "react";
import type { MemoryStatusResponse } from "@/lib/api-types";
import {
  EMPTY_MEMORY_STATUS_SNAPSHOT,
  getMemoryStatusSnapshot,
  refreshMemoryStatus,
  subscribeMemoryStatus,
  type MemoryStatusSnapshot,
} from "@/lib/memory-status-store";

export { MEMORY_STATUS_POLL_INTERVAL_MS } from "@/lib/memory-status-store";

export interface MemoryStatusOptions {
  /** Read the status at all (false in normal mode, where nothing acts on it). */
  enabled: boolean;
  /** Keep the shared poll loop alive while visible. Only Lite mode polls. */
  poll: boolean;
}

export interface MemoryStatusResult {
  status: MemoryStatusResponse | null;
  error: string | null;
  /** Re-read once. */
  refresh: () => Promise<void>;
}

/**
 * Subscribes to the shared memory-status store (lib/memory-status-store.ts).
 * Every surface renders the same snapshot and one poll loop serves them all.
 * Display only: the policy that acts on pressure belongs to the server
 * (lib/lite-memory-monitor.ts).
 */
export function useMemoryStatus({ enabled, poll }: MemoryStatusOptions): MemoryStatusResult {
  const [snapshot, setSnapshot] = useState<MemoryStatusSnapshot>(EMPTY_MEMORY_STATUS_SNAPSHOT);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(EMPTY_MEMORY_STATUS_SNAPSHOT);
      return;
    }
    setSnapshot(getMemoryStatusSnapshot());
    const unsubscribe = subscribeMemoryStatus(setSnapshot, { poll });
    void refreshMemoryStatus();
    return unsubscribe;
  }, [enabled, poll]);

  return {
    status: snapshot.status,
    error: snapshot.error,
    refresh: refreshMemoryStatus,
  };
}
