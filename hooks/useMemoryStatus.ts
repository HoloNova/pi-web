"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryStatusResponse } from "@/lib/api-types";
import { liteModeRequestHeaders } from "@/lib/lite-request";

/**
 * The status read is deliberately slow. It measures the service and, in Lite
 * mode, runs a bounded idle-session reclaim pass, so polling it hard would
 * create work for an otherwise idle Pi-Web. Ten seconds keeps the readout
 * current without a busy loop, and polling pauses while the tab is hidden.
 */
export const MEMORY_STATUS_POLL_INTERVAL_MS = 10_000;

export interface MemoryStatusOptions {
  /** Read the status at all (false in normal mode, where nothing acts on it). */
  enabled: boolean;
  /** Keep polling while visible. Only Lite mode acts on the result. */
  poll: boolean;
}

export interface MemoryStatusResult {
  status: MemoryStatusResponse | null;
  error: string | null;
  /** Re-read once (after a target save). */
  refresh: () => Promise<void>;
}

export function useMemoryStatus({ enabled, poll }: MemoryStatusOptions): MemoryStatusResult {
  const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);

  // Declared first so it re-asserts mountedRef after Strict Mode's simulated
  // unmount, before the status effect below runs on the replay.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/memory", {
        headers: liteModeRequestHeaders(),
        cache: "no-store",
      });
      const data = await response.json() as MemoryStatusResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (!mountedRef.current) return;
      setStatus(data);
      setError(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setError(null);
      return;
    }
    void load();
    if (!poll) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => { void load(); }, MEMORY_STATUS_POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, poll, load]);

  return { status, error, refresh: load };
}
