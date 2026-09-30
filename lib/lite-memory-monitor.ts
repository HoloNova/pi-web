import {
  memoryPressureState,
  shouldReclaimForMemoryState,
  type MemoryPressureState,
} from "@/lib/memory-pressure";
import { readLiteConfig } from "@/lib/lite-config-settings";
import { readServiceMemoryReading } from "@/lib/service-memory";
import { runMemoryPressureReclaim } from "@/lib/rpc-manager";
import type { ReclaimPassResult } from "@/lib/lite-memory-reclaim";

/**
 * How often the policy looks at the service footprint.
 *
 * The monitor owns the memory target: it measures, decides and reclaims on its
 * own, so nothing about memory policy depends on a browser being open. The tick
 * is deliberately cheap in the common case — read the configuration, read
 * `memory.current`, compare the two — and only walks sessions when the reading
 * reaches the near threshold (90% of the target) or the target itself.
 *
 * Fifteen seconds keeps a reclaim reaction close to the pressure that caused it
 * without turning the policy into a busy loop, and the interval stays a constant
 * rather than another setting to explain.
 *
 * Pressure is the *near* threshold, not the target itself: the policy starts
 * acting at 90% of the target (`MEMORY_NEAR_TARGET_RATIO`), which is what leaves
 * it room to reclaim before the target is crossed.
 */
export const MEMORY_MONITOR_INTERVAL_MS = 15_000;

export interface MemoryMonitorDeps {
  /** The instance's Lite configuration; `enabled` gates the whole policy. */
  liteConfig(): { enabled: boolean; memoryTargetMiB: number };
  /** The service's own footprint. */
  readMemory(): { bytes: number };
  state(usedBytes: number, targetMiB: number): MemoryPressureState;
  /** One reclaim pass; closes at most the oldest eligible session. */
  reclaim(): ReclaimPassResult;
  log(message: string): void;
}

export type MemoryMonitorTickResult = "disabled" | "below-target" | "reclaimed" | "nothing-to-close";

const defaultDeps: MemoryMonitorDeps = {
  liteConfig: () => {
    const config = readLiteConfig();
    return { enabled: config.enabled, memoryTargetMiB: config.memoryTargetMiB };
  },
  readMemory: () => ({ bytes: readServiceMemoryReading().bytes }),
  state: (usedBytes, targetMiB) => memoryPressureState(usedBytes, targetMiB),
  reclaim: () => runMemoryPressureReclaim(),
  log: (message) => console.info(`[pi-web] ${message}`),
};

/**
 * One policy tick.
 *
 * Lite mode off: nothing is measured and nothing is closed — the target only
 * exists in Lite mode.
 *
 * Below the near threshold (90% of the target): measurement only; no session is
 * inspected.
 *
 * At or above the near threshold — including a reading that has not reached the
 * target yet: one reclaim pass, which closes at most the oldest eligible session
 * and may close nothing at all. A service that cannot free anything stays under
 * pressure until the next tick. Nothing is ever killed.
 */
export function runLiteMemoryMonitorTick(deps: MemoryMonitorDeps = defaultDeps): MemoryMonitorTickResult {
  const config = deps.liteConfig();
  if (!config.enabled) return "disabled";

  const usedBytes = deps.readMemory().bytes;
  if (!shouldReclaimForMemoryState(deps.state(usedBytes, config.memoryTargetMiB))) return "below-target";

  const result = deps.reclaim();
  if (result.reclaimed.length === 0) return "nothing-to-close";
  // One line per pass that closed something: the policy acts without a browser,
  // so this is how its effect shows up in the service log.
  deps.log(
    `memory policy closed ${result.reclaimed.length} idle session(s): `
    + `${result.reclaimable} idle, ${result.running} running, ${result.viewed} viewed, `
    + `${result.delegated} with delegated work`,
  );
  return "reclaimed";
}

declare global {
  // One monitor per process, whatever module instance started it: Next can build
  // separate module graphs, so a module-level `setInterval` could run more than
  // once. The value is the running interval, which is also the singleton marker.
  var __piWebLiteMemoryMonitor: ReturnType<typeof setInterval> | undefined;
}

export interface StartMemoryMonitorOptions {
  intervalMs?: number;
  deps?: MemoryMonitorDeps;
  log?(message: string): void;
}

/**
 * Start the process's memory policy monitor and return a stop function.
 *
 * Idempotent by design: a second call (another module graph, a test) leaves the
 * running monitor alone instead of adding a second interval. The timer is
 * unref'd, so the policy never keeps the process alive on its own.
 */
export function startLiteMemoryMonitor(options: StartMemoryMonitorOptions = {}): () => void {
  const log = options.log ?? ((message: string) => console.info(`[pi-web] ${message}`));
  if (globalThis.__piWebLiteMemoryMonitor !== undefined) {
    log("memory policy monitor is already running");
    return () => {};
  }

  const deps = options.deps ?? defaultDeps;
  const intervalMs = options.intervalMs ?? MEMORY_MONITOR_INTERVAL_MS;
  // One line so an operator can tell the policy is on at all; quiet ticks log
  // nothing, and a pass that closed something logs its own line.
  log(`memory policy monitor started, every ${Math.round(intervalMs / 1000)}s`);
  const timer = setInterval(() => {
    try {
      runLiteMemoryMonitorTick(deps);
    } catch (error) {
      // A failed tick must never take the server down; the next one retries.
      log(`memory policy tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, intervalMs);
  // Housekeeping only: never hold the process open.
  timer.unref?.();
  globalThis.__piWebLiteMemoryMonitor = timer;

  return () => {
    if (globalThis.__piWebLiteMemoryMonitor !== timer) return;
    clearInterval(timer);
    globalThis.__piWebLiteMemoryMonitor = undefined;
  };
}

/** Test seam: whether this process already runs a monitor. */
export function isLiteMemoryMonitorRunning(): boolean {
  return globalThis.__piWebLiteMemoryMonitor !== undefined;
}
