// Per-tab presence bookkeeping for Lite mode. Acquire is idempotent and a
// release is deferred briefly so React Strict Mode's simulated unmount
// (effect cleanup followed by the same effect re-running) never sends a
// release that then races its own re-acquire. A genuine unmount, session
// switch, or page hide ultimately sends the release, so a Lite tab reliably
// gives the session back once it stops holding it (switch, close, or idle past
// the deadline).

export interface LitePresenceTransport {
  acquire(sessionId: string, clientId: string): void;
  renew(sessionId: string, clientId: string): void;
  release(sessionId: string, clientId: string): void;
}

export interface LitePresenceControllerOptions {
  /** Grace period that absorbs a Strict Mode remount before releasing. */
  releaseDelayMs?: number;
}

export interface LitePresenceController {
  /** Start holding a session's presence (no-op when already held). */
  hold(sessionId: string): void;
  /** Refresh the hold's server-side TTL; ignored when not held. */
  renew(sessionId: string): void;
  /** Stop holding. Deferred unless `immediate` is set (page hide / dispose). */
  release(sessionId: string, options?: { immediate?: boolean }): void;
  dispose(): void;
  heldSessionIds(): string[];
}

interface HeldEntry {
  timer: ReturnType<typeof setTimeout> | null;
}

export function createLitePresenceController(
  clientId: string,
  transport: LitePresenceTransport,
  options: LitePresenceControllerOptions = {},
): LitePresenceController {
  const releaseDelayMs = options.releaseDelayMs ?? 250;
  const held = new Map<string, HeldEntry>();

  const clearTimer = (entry: HeldEntry) => {
    if (!entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  };

  const sendRelease = (sessionId: string) => {
    const entry = held.get(sessionId);
    if (!entry) return;
    clearTimer(entry);
    held.delete(sessionId);
    transport.release(sessionId, clientId);
  };

  return {
    hold(sessionId) {
      if (!sessionId) return;
      const entry = held.get(sessionId);
      if (entry) {
        // A pending release (Strict Mode remount, quick switch back) is cancelled;
        // presence was never dropped server-side, so no acquire is needed.
        clearTimer(entry);
        return;
      }
      held.set(sessionId, { timer: null });
      transport.acquire(sessionId, clientId);
    },
    renew(sessionId) {
      if (!held.has(sessionId)) return;
      transport.renew(sessionId, clientId);
    },
    release(sessionId, releaseOptions = {}) {
      const entry = held.get(sessionId);
      if (!entry) return;
      clearTimer(entry);
      if (releaseOptions.immediate) {
        sendRelease(sessionId);
        return;
      }
      entry.timer = setTimeout(() => sendRelease(sessionId), releaseDelayMs);
    },
    dispose() {
      for (const sessionId of [...held.keys()]) sendRelease(sessionId);
    },
    heldSessionIds() {
      return [...held.keys()];
    },
  };
}
