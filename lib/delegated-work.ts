// Detects delegated work that is still executing underneath a session.
//
// `AgentSessionWrapper.isRunning()` only describes the wrapper's *own* turn: a
// pending prompt, streaming output, a compaction or a shell command. A delegated
// child — an async subagent run, a workflow — keeps working after the parent
// turn has already returned, so a session like that looks idle while a child is
// still using the machine and, for in-process children, still living inside the
// same pi process. Closing the parent there loses the run outright.
//
// One signal, read-only and plugin-agnostic: every child run writes its own
// session under `<session file without .jsonl>/<child id>/run-N/session.jsonl`,
// so a recent write anywhere in that subtree means a child is alive. That layout
// is shared by the built-in subagent runtime and by plugin-spawned runs alike, so
// nothing here has to read another plugin's private state.
//
// The answer is a heuristic, not a guarantee: a child that writes nothing for
// longer than the activity window is invisible here, and the check only reads the
// filesystem. It fails closed in the other direction — an unreadable directory or
// a scan that had to stop early is reported as BUSY. Holding a session a little
// longer is recoverable; killing a child mid-run is not.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** How recent a write under the artifact directory must be to count as activity. */
export const DEFAULT_DELEGATED_ACTIVITY_WINDOW_MS = 3 * 60 * 1000;
export const MIN_DELEGATED_ACTIVITY_WINDOW_MS = 10 * 1000;
export const MAX_DELEGATED_ACTIVITY_WINDOW_MS = 30 * 60 * 1000;
/**
 * How long a BUSY answer is reused, so a polling page cannot rescan constantly.
 *
 * Only the busy answer is cached, and the asymmetry is deliberate. A busy that
 * outlives its cause costs a session a little extra lifetime — it is closed on a
 * later check. A quiet that outlives its cause is the dangerous direction: a
 * child that starts right after the scan would be invisible for the rest of the
 * TTL, and closing the parent then kills a live child. So a quiet answer is
 * measured again on every call; the scan it costs is bounded (see
 * `hasRecentArtifactActivity`).
 */
export const DELEGATED_WORK_CACHE_TTL_MS = 10 * 1000;

const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_ENTRIES = 500;

export interface DelegatedWorkFs {
  readdirSync(path: string): Array<{ name: string; isDirectory(): boolean }>;
  statSync(path: string): { mtimeMs: number };
}

const nodeFs: DelegatedWorkFs = {
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
  statSync: (path) => ({ mtimeMs: statSync(path).mtimeMs }),
};

declare global {
  // Shared across module instances (bundler/jiti duplication, tests) the same way
  // the session registry and subagent runs are: every caller must see one cache.
  // Values are the timestamps of the last BUSY answer per cache key.
  var __piDelegatedWorkCache: Map<string, number> | undefined;
}

function cacheMap(): Map<string, number> {
  if (!globalThis.__piDelegatedWorkCache) globalThis.__piDelegatedWorkCache = new Map();
  return globalThis.__piDelegatedWorkCache;
}

/** Test seam: drop every cached answer. */
export function clearDelegatedWorkCache(): void {
  cacheMap().clear();
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/** Window override, clamped; `PI_WEB_DELEGATED_ACTIVITY_WINDOW_MS` (ms). */
export function resolveDelegatedActivityWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PI_WEB_DELEGATED_ACTIVITY_WINDOW_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DELEGATED_ACTIVITY_WINDOW_MS;
  return Math.min(MAX_DELEGATED_ACTIVITY_WINDOW_MS, Math.max(MIN_DELEGATED_ACTIVITY_WINDOW_MS, Math.round(raw)));
}

/**
 * Where a session's delegated children live: its own JSONL path without the
 * `.jsonl` suffix. Returns null when the path cannot describe one.
 */
export function sessionArtifactDir(sessionFile: string | null | undefined): string | null {
  if (typeof sessionFile !== "string") return null;
  const trimmed = sessionFile.trim();
  if (!trimmed || !trimmed.endsWith(".jsonl")) return null;
  const dir = trimmed.slice(0, -".jsonl".length);
  return dir || null;
}

/**
 * True when anything in the session's artifact subtree was written within the
 * window. Bounded in depth and entry count so a large history cannot turn a
 * reclaim check into an unbounded directory walk.
 *
 * Both bounds are places where the scan stops early, and both report BUSY: the
 * subtree below them was never read, so "no recent write found" would be a
 * guess, and a wrong guess here is the one that kills a running child. An
 * unreadable directory is treated the same way.
 */
export function hasRecentArtifactActivity(
  dir: string,
  options: { now: number; windowMs: number; fs?: DelegatedWorkFs },
): boolean {
  const fs = options.fs ?? nodeFs;
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop() as { path: string; depth: number };
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = fs.readdirSync(current.path);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      return true;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_SCAN_ENTRIES) return true;
      const full = join(current.path, entry.name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch (error) {
        if (isMissingPathError(error)) continue;
        return true;
      }
      if (options.now - mtimeMs <= options.windowMs) return true;
      if (entry.isDirectory()) {
        if (current.depth >= MAX_SCAN_DEPTH) return true;
        stack.push({ path: full, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

export interface DelegatedWorkInput {
  /** Session id; part of the cache key, so two sessions never share an answer. */
  sessionId?: string;
  /** Session JSONL path; its suffix-less twin is the artifact directory. */
  sessionFile?: string;
  now?: number;
  windowMs?: number;
  /** Test seams. `undefined` means "derive from sessionFile"; `null` means "none". */
  artifactDir?: string | null;
  fs?: DelegatedWorkFs;
  bypassCache?: boolean;
}

/**
 * True when this session still has delegated work running: something wrote under
 * its artifact directory within the activity window.
 *
 * A session without a usable session file has no artifact directory and therefore
 * no children to find. Read-only throughout — a missing directory, a missing
 * session file and an unreadable tree all resolve to an answer, never an error.
 */
export function hasDelegatedWorkRunning(input: DelegatedWorkInput): boolean {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? resolveDelegatedActivityWindowMs();
  const artifactDir = input.artifactDir !== undefined ? input.artifactDir : sessionArtifactDir(input.sessionFile);
  const cacheKey = `${artifactDir ?? ""}\u0000${input.sessionId ?? ""}\u0000${windowMs}`;
  const cache = cacheMap();
  if (input.bypassCache !== true) {
    // A cached busy stands for the full TTL; a quiet answer is never kept.
    const answeredAt = cache.get(cacheKey);
    if (answeredAt !== undefined && now - answeredAt < DELEGATED_WORK_CACHE_TTL_MS) return true;
  }
  const busy = artifactDir
    ? hasRecentArtifactActivity(artifactDir, { now, windowMs, ...(input.fs ? { fs: input.fs } : {}) })
    : false;
  if (busy) {
    cache.set(cacheKey, now);
    if (cache.size > 256) {
      for (const [key, seenAt] of cache) {
        if (now - seenAt >= DELEGATED_WORK_CACHE_TTL_MS) cache.delete(key);
      }
    }
  } else {
    // The opposite direction must not be cached: a child that starts just after
    // this scan has to be visible on the very next call (see the TTL note).
    cache.delete(cacheKey);
  }
  return busy;
}
