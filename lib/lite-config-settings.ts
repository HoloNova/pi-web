import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  DEFAULT_LITE_CONFIG,
  MAX_LITE_IDLE_MINUTES,
  MAX_MEMORY_TARGET_MIB,
  MIN_LITE_IDLE_MINUTES,
  MIN_MEMORY_TARGET_MIB,
  coerceLiteConfig,
  isValidLiteIdleMinutes,
  isValidMemoryTargetMiB,
  type LiteConfig,
} from "./lite-config";

/**
 * Pi-Web owns this file. Its settings are read and written by this server and
 * shared by every client, so they must never be written into pi's own
 * settings.json, models.json, agents/settings.json, or any plugin config: those
 * belong to other runtimes and are rewritten wholesale by them.
 */
export const LITE_SETTINGS_FILE_NAME = "pi-web-settings.json";
export const LITE_SETTINGS_VERSION = 1;

type StoredSettings = Record<string, unknown> & { version?: unknown; lite?: unknown };

export function getLiteSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, LITE_SETTINGS_FILE_NAME);
}

function readStored(path: string): StoredSettings {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid pi-web settings: expected an object");
  }
  return parsed as StoredSettings;
}

/**
 * The stored configuration, with defaults for anything missing or unreadable:
 * these values are policy, so a damaged file must not break a settings read.
 */
export function readLiteConfig(path = getLiteSettingsPath()): LiteConfig {
  try {
    return coerceLiteConfig(readStored(path).lite);
  } catch {
    return { ...DEFAULT_LITE_CONFIG };
  }
}

/**
 * Whether the model and provider reads should answer from the built-in
 * catalogue only.
 *
 * A Lite instance does that unless `extensionModels` is on: extension-registered
 * providers then show up exactly as they do in normal mode, and the read takes
 * the extension-loading path with it.
 */
export function readsUseLiteCatalog(path = getLiteSettingsPath()): boolean {
  const config = readLiteConfig(path);
  return config.enabled && !config.extensionModels;
}

/** The fields a caller may change; anything omitted keeps its stored value. */
export type LiteConfigPatch = Partial<LiteConfig>;

/**
 * Merge a patch into the stored configuration and write it with a minimal edit:
 * unknown fields already in the file are preserved, an out-of-range value is
 * rejected, and an unreadable file is never overwritten — the same rule the
 * models settings follow.
 */
export function writeLiteConfig(patch: LiteConfigPatch, path = getLiteSettingsPath()): LiteConfig {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (patch.idleMinutes !== undefined && !isValidLiteIdleMinutes(patch.idleMinutes)) {
    throw new Error(`idleMinutes must be a whole number between ${MIN_LITE_IDLE_MINUTES} and ${MAX_LITE_IDLE_MINUTES}`);
  }
  if (patch.memoryTargetMiB !== undefined && !isValidMemoryTargetMiB(patch.memoryTargetMiB)) {
    throw new Error(`memoryTargetMiB must be a whole number between ${MIN_MEMORY_TARGET_MIB} and ${MAX_MEMORY_TARGET_MIB}`);
  }
  if (patch.extensionModels !== undefined && typeof patch.extensionModels !== "boolean") {
    throw new Error("extensionModels must be a boolean");
  }
  const stored = readStored(path);
  const next: LiteConfig = { ...coerceLiteConfig(stored.lite), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(
    path,
    JSON.stringify({ ...stored, version: LITE_SETTINGS_VERSION, lite: next }, null, 2),
  );
  return next;
}
