"use client";

import { useEffect, useRef } from "react";
import { getClientId } from "@/lib/client-identity";
import { useLiteConfig } from "@/hooks/useLiteConfig";
import {
  LITE_INTERACTION_EVENTS,
  liteIdleDeadlineIn,
  liteIdleMinutesToMs,
  shouldHoldLitePresence,
} from "@/lib/lite-lifecycle";
import { createLitePresenceController, type LitePresenceController } from "@/lib/lite-presence";

export const LITE_PRESENCE_RENEW_INTERVAL_MS = 30_000;

type PresenceAction = "acquire" | "renew" | "release";

function postPresence(
  sessionId: string,
  clientId: string,
  action: PresenceAction,
  keepalive = false,
): void {
  void fetch(`/api/agent/${encodeURIComponent(sessionId)}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, action }),
    cache: "no-store",
    keepalive,
  }).catch(() => {
    // The next renew tick retries; lease expiry covers a lost release.
  });
}

export interface LiteSessionLifecycleOptions {
  /** Selected session, or null when no conversation is open. */
  sessionId: string | null;
  /** The instance runs Lite mode (a server-wide setting). */
  enabled: boolean;
  /**
   * Called whenever this page starts or stops holding presence for its
   * session. `useAgentSession` uses it to close/reopen the SSE stream.
   */
  onHoldChange(hold: boolean, sessionId: string): void;
}

/**
 * Owns this page's Lite-mode presence for the selected session.
 *
 * A mounted page holds presence while Lite mode is on and the last real
 * interaction is within the configured idle window (see lib/lite-lifecycle.ts);
 * visibility does not gate it, so switching tabs, minimizing, or switching
 * applications keeps the session warm. The window is the instance's
 * `idleMinutes`, read from the server config, so changing it there re-arms the
 * deadline for the current session without dropping presence or reloading.
 *
 * Presence is otherwise dropped by a conversation switch (this effect's
 * cleanup), a page close (`pagehide`), the idle deadline, or the 90 s server
 * lease TTL when a frozen tab stops renewing. Dropping it lets the server
 * reclaim the idle wrapper once no other tab or device holds the session.
 * Normal mode never touches presence.
 */
export function useLiteSessionLifecycle({
  sessionId,
  enabled,
  onHoldChange,
}: LiteSessionLifecycleOptions): void {
  const onHoldChangeRef = useRef(onHoldChange);
  onHoldChangeRef.current = onHoldChange;

  const { snapshot } = useLiteConfig();
  const idleMinutes = snapshot.config.idleMinutes;
  const idleTimeoutMsRef = useRef(liteIdleMinutesToMs(idleMinutes));
  idleTimeoutMsRef.current = liteIdleMinutesToMs(idleMinutes);
  // Set by the presence effect, invoked when the configured idle minutes
  // change: it re-schedules the deadline and re-evaluates without tearing down
  // (and re-acquiring) the current hold.
  const rearmRef = useRef<(() => void) | null>(null);

  const controllerRef = useRef<LitePresenceController | null>(null);
  if (!controllerRef.current && typeof window !== "undefined") {
    controllerRef.current = createLitePresenceController(getClientId(), {
      acquire: (sid, cid) => postPresence(sid, cid, "acquire"),
      renew: (sid, cid) => postPresence(sid, cid, "renew"),
      release: (sid, cid) => postPresence(sid, cid, "release", true),
    });
  }
  // The controller is deliberately not disposed on unmount: React Strict Mode
  // runs every cleanup before re-running the same effect, and an immediate
  // dispose there would send a release that races its own re-acquire. The
  // debounced release in this effect's cleanup (and pagehide) already covers a
  // real unmount or page close.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!enabled || !sessionId || !controller) return;
    const sid = sessionId;
    let holding = false;
    let lastInteractionAt = Date.now();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let renewTimer: ReturnType<typeof setInterval> | null = null;

    const evaluate = () => {
      const hold = shouldHoldLitePresence({
        enabled: true,
        mounted: true,
        lastInteractionAt,
        now: Date.now(),
        idleTimeoutMs: idleTimeoutMsRef.current,
      });
      if (hold === holding) return;
      holding = hold;
      if (hold) {
        controller.hold(sid);
        if (!renewTimer) {
          renewTimer = setInterval(() => controller.renew(sid), LITE_PRESENCE_RENEW_INTERVAL_MS);
        }
      } else {
        if (renewTimer) {
          clearInterval(renewTimer);
          renewTimer = null;
        }
        controller.release(sid);
      }
      onHoldChangeRef.current(hold, sid);
    };

    const scheduleIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        evaluate();
      }, liteIdleDeadlineIn(lastInteractionAt, Date.now(), idleTimeoutMsRef.current));
    };

    const onInteraction = () => {
      lastInteractionAt = Date.now();
      scheduleIdle();
      evaluate();
    };
    // Cheap re-evaluation when the tab wakes: a tab frozen past the deadline
    // releases here. A visibility change alone never releases — the deadline is
    // measured from the last real interaction, not from becoming visible.
    const onVisibility = () => {
      scheduleIdle();
      evaluate();
    };
    const onPageHide = () => {
      if (!holding) return;
      holding = false;
      controller.release(sid, { immediate: true });
      onHoldChangeRef.current(false, sid);
    };

    for (const event of LITE_INTERACTION_EVENTS) {
      window.addEventListener(event, onInteraction, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    scheduleIdle();
    evaluate();

    // A change to the configured idle window re-arms this deadline; the new
    // value is read from idleTimeoutMsRef.current, so presence is only dropped
    // if the new deadline is already past.
    rearmRef.current = () => {
      scheduleIdle();
      evaluate();
    };

    return () => {
      rearmRef.current = null;
      for (const event of LITE_INTERACTION_EVENTS) {
        window.removeEventListener(event, onInteraction);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      if (idleTimer) clearTimeout(idleTimer);
      if (renewTimer) clearInterval(renewTimer);
      controller.release(sid);
      if (holding) {
        holding = false;
        onHoldChangeRef.current(false, sid);
      }
    };
  }, [enabled, sessionId]);

  useEffect(() => {
    rearmRef.current?.();
  }, [idleMinutes]);
}
