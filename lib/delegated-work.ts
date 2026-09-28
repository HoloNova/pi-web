// Detects delegated work that is still executing underneath a session.
//
// `AgentSessionWrapper.isRunning()` only describes the wrapper's *own* turn: a
// pending prompt, streaming output, a compaction or a shell command. A delegated
// child — an async subagent run, a workflow — keeps working after the parent
// turn has already returned, so a session like that looks idle while a child is
// still using the machine and, for in-process children, still living inside the
// same pi process. Closing the parent there loses the run outright, which is
// exactly what Lite mode promises never to do.
//
// Two independent signals, both read-only and both tolerant of a missing source:
//
// 1. Artifact activity (plugin-agnostic). Every child run writes its own session
//    under `<session file without .jsonl>/<child id>/run-N/session.jsonl`, so a
//    recent write anywhere in that subtree means a child is alive. This does not
//    depend on knowing which plugin spawned the child.
// 2. The pi-subagents run registry
//    (`<tmp>/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/status.json`),
//    which names the parent session file and the run state outright. This is a
//    best-effort refinement: a missing directory, unparseable file or changed
//    schema simply falls back to (1) instead of failing the check.
//
// Anything that cannot be read is treated as BUSY (fail closed). Holding a
// session a little longer is recoverable; killing a child mid-run is not.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How recent a write under the artifact directory must be to count as activity. */
export const DEFAULT_DELEGATED_ACTIVITY_WINDOW_MS = 3 * 60 * 1000;
export const MIN_DELEGATED_ACTIVITY_WINDOW_MS = 10 * 1000;
export const MAX_DELEGATED_ACTIVITY_WINDOW_MS = 30 * 60 * 1000;
/** How long one combined answer is reused, so a polling page cannot rescan constantly. */
export const DELEGATED_WORK_CACHE_TTL_MS = 10 * 1000;

const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_ENTRIES = 500;
const MAX_PLUGIN_RUNS_SCANNED = 24;
/** Grace past a run's own deadline before it is treated as gone. */
const PLUGIN_DEADLINE_SLACK_MS = 60 * 1000;
/** A matched run with no terminal state and no usable deadline stops counting eventually. */
const PLUGIN_STALE_RUN_MS = 2 * 60 * 60 * 1000;

/** Run states that mean the child is still working (built-in subagent vocabulary). */
export const ACTIVE_SUBAGENT_STATUSES = new Set(["starting", "queued", "running"]);

/** Run states that prove a plugin run is over. Unknown states are treated as active. */
export const TERMINAL_PLUGIN_RUN_STATES = new Set([
  "complete",
  "completed",
  "failed",
  "error",
  "stopped",
  "aborted",
  "cancelled",
  "canceled",
  "expired",
  "timeout",
  "timedout",
]);

export interface DelegatedWorkFs {
  readdirSync(path: string): Array<{ name: string; isDirectory(): boolean }>;
  statSync(path: string): { mtimeMs: number };
  readFileSync(path: string, encoding: "utf8"): string;
}

const nodeFs: DelegatedWorkFs = {
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
  statSync: (path) => ({ mtimeMs: statSync(path).mtimeMs }),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
};

declare global {
  // Shared across module instances (bundler/jiti duplication, tests) the same way
  // the session registry and subagent runs are: every caller must see one cache.
  var __piDelegatedWorkCache: Map<string, { at: number; busy: boolean }> | undefined;
}

function cacheMap(): Map<string, { at: number; busy: boolean }> {
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
 * reclaim check into a directory walk; an unreadable directory counts as busy.
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
      if (seen > MAX_SCAN_ENTRIES) return false;
      const full = join(current.path, entry.name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch (error) {
        if (isMissingPathError(error)) continue;
        return true;
      }
      if (options.now - mtimeMs <= options.windowMs) return true;
      if (entry.isDirectory() && current.depth < MAX_SCAN_DEPTH) {
        stack.push({ path: full, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

/** Default location of the pi-subagents run registry. */
export function defaultPluginRunsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.PI_WEB_SUBAGENT_RUNS_DIR?.trim();
  if (override) return override;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return null;
  return join(tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs");
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as { code?: unknown } | null)?.code === "EPERM";
  }
}

function runMentionsSession(run: Record<string, unknown>, input: { sessionId?: string; sessionFile?: string }): boolean {
  const artifactDir = sessionArtifactDir(input.sessionFile);
  const values = [run.sessionId, run.sessionFile, run.parentSessionId].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  for (const value of values) {
    if (input.sessionFile && value === input.sessionFile) return true;
    if (input.sessionId && value === input.sessionId) return true;
    if (artifactDir && value === artifactDir) return true;
  }
  const root = typeof run.sessionRoot === "string" ? run.sessionRoot : undefined;
  return Boolean(root && artifactDir && root === artifactDir);
}

function runIsProvablyFinished(run: Record<string, unknown>, now: number): boolean {
  const state = typeof run.state === "string" ? run.state.trim().toLowerCase() : "";
  if (state && TERMINAL_PLUGIN_RUN_STATES.has(state)) return true;
  const deadline = typeof run.deadlineAt === "number" ? run.deadlineAt : undefined;
  if (deadline !== undefined && Number.isFinite(deadline) && now > deadline + PLUGIN_DEADLINE_SLACK_MS) return true;
  if (deadline === undefined) {
    const lastUpdate = typeof run.lastUpdate === "number" ? run.lastUpdate : undefined;
    const startedAt = typeof run.startedAt === "number" ? run.startedAt : undefined;
    const reference = lastUpdate ?? startedAt;
    if (reference !== undefined && Number.isFinite(reference) && now - reference > PLUGIN_STALE_RUN_MS) return true;
  }
  return false;
}

/**
 * True when the pi-subagents registry holds a run for this session that is not
 * provably finished. Unknown shapes are skipped, never guessed at.
 */
export function hasActivePluginRun(input: {
  sessionId?: string;
  sessionFile?: string;
  now: number;
  runsDir?: string | null;
  fs?: DelegatedWorkFs;
  pidAlive?: (pid: number) => boolean;
}): boolean {
  // The registry records the parent session *path*; without one there is nothing
  // to match, and a brand-new session cannot own a child run yet.
  if (!input.sessionFile) return false;
  const runsDir = input.runsDir === undefined ? defaultPluginRunsDir() : input.runsDir;
  if (!runsDir) return false;
  const fs = input.fs ?? nodeFs;
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return false;
  }
  const newest = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(runsDir, entry.name);
      let mtimeMs = 0;
      // Rank on the state file, not the directory: appending to events.jsonl
      // does not bump the directory's own mtime.
      for (const candidate of [join(dir, "status.json"), dir]) {
        try {
          mtimeMs = fs.statSync(candidate).mtimeMs;
          break;
        } catch {
          mtimeMs = 0;
        }
      }
      return { name: entry.name, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_PLUGIN_RUNS_SCANNED);

  for (const entry of newest) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(join(runsDir, entry.name, "status.json"), "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const run = parsed as Record<string, unknown>;
    if (!runMentionsSession(run, input)) continue;
    if (runIsProvablyFinished(run, input.now)) continue;
    const pid = typeof run.pid === "number" && Number.isInteger(run.pid) ? run.pid : undefined;
    if (pid !== undefined && !(input.pidAlive ?? defaultPidAlive)(pid)) continue;
    return true;
  }
  return false;
}

export interface DelegatedWorkInput {
  /** Session id, matched against run state that records ids instead of paths. */
  sessionId?: string;
  /** Session JSONL path; its suffix-less twin is the artifact directory. */
  sessionFile?: string;
  now?: number;
  windowMs?: number;
  /** Test seams. `undefined` means "derive from sessionFile"; `null` means "none". */
  artifactDir?: string | null;
  pluginRunsDir?: string | null;
  fs?: DelegatedWorkFs;
  pidAlive?: (pid: number) => boolean;
  bypassCache?: boolean;
}

/**
 * True when this session still has delegated work running: recent child writes
 * under its artifact directory, or an unfinished run in the plugin registry.
 *
 * The artifact check runs first because it short-circuits on the first fresh
 * file; the registry probe then only fills in the case of a child that has gone
 * quiet for longer than the window.
 */
export function hasDelegatedWorkRunning(input: DelegatedWorkInput): boolean {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? resolveDelegatedActivityWindowMs();
  const artifactDir = input.artifactDir !== undefined ? input.artifactDir : sessionArtifactDir(input.sessionFile);
  const cacheKey = `${artifactDir ?? ""}\u0000${input.sessionId ?? ""}\u0000${windowMs}`;
  const cache = cacheMap();
  if (input.bypassCache !== true) {
    const cached = cache.get(cacheKey);
    if (cached && now - cached.at < DELEGATED_WORK_CACHE_TTL_MS) return cached.busy;
  }
  let busy = false;
  if (artifactDir) {
    busy = hasRecentArtifactActivity(artifactDir, { now, windowMs, ...(input.fs ? { fs: input.fs } : {}) });
  }
  if (!busy) {
    busy = hasActivePluginRun({
      now,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
      runsDir: input.pluginRunsDir === undefined ? undefined : input.pluginRunsDir,
      ...(input.fs ? { fs: input.fs } : {}),
      ...(input.pidAlive ? { pidAlive: input.pidAlive } : {}),
    });
  }
  cache.set(cacheKey, { at: now, busy });
  if (cache.size > 256) {
    for (const [key, value] of cache) {
      if (now - value.at >= DELEGATED_WORK_CACHE_TTL_MS) cache.delete(key);
    }
  }
  return busy;
}
