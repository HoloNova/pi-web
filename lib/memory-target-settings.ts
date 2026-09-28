import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  DEFAULT_MEMORY_TARGET_MIB,
  MAX_MEMORY_TARGET_MIB,
  MIN_MEMORY_TARGET_MIB,
  isValidMemoryTargetMiB,
} from "./memory-target";

/**
 * Pi-Web owns this file. The memory target must never be written into pi's own
 * settings.json, models.json, agents/settings.json, or any plugin config: those
 * belong to other runtimes and are rewritten wholesale by them.
 */
export const MEMORY_TARGET_FILE_NAME = "pi-web-memory.json";

type StoredMemoryTarget = Record<string, unknown> & { version?: unknown; targetMiB?: unknown };

export function getMemoryTargetSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, MEMORY_TARGET_FILE_NAME);
}

function readStored(path: string): StoredMemoryTarget {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid pi-web memory settings: expected an object");
  }
  return parsed as StoredMemoryTarget;
}

/**
 * The stored target, or the default when the file is missing, unreadable, or
 * holds a value outside the supported range. The target is advisory, so a
 * damaged file falls back to the default instead of failing a status read.
 */
export function readMemoryTargetMiB(path = getMemoryTargetSettingsPath()): number {
  try {
    const stored = readStored(path);
    return isValidMemoryTargetMiB(stored.targetMiB) ? stored.targetMiB : DEFAULT_MEMORY_TARGET_MIB;
  } catch {
    return DEFAULT_MEMORY_TARGET_MIB;
  }
}

/**
 * Write the target with a minimal edit: unknown fields already in the file are
 * preserved. An out-of-range value is rejected, and an unreadable file is never
 * overwritten, matching the models.json rule.
 */
export function writeMemoryTargetMiB(
  targetMiB: number,
  path = getMemoryTargetSettingsPath(),
): number {
  if (!isValidMemoryTargetMiB(targetMiB)) {
    throw new Error(
      `targetMiB must be a whole number between ${MIN_MEMORY_TARGET_MIB} and ${MAX_MEMORY_TARGET_MIB}`,
    );
  }
  const stored = readStored(path);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ ...stored, version: 1, targetMiB }, null, 2));
  return targetMiB;
}
