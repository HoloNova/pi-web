import {
  DEFAULT_LITE_CONFIG,
  LITE_CONFIG_BOUNDS,
  coerceLiteConfig,
  type LiteConfig,
  type LiteConfigBounds,
  type LiteValueBounds,
} from "./lite-config";

/**
 * The page's view of the instance's Lite configuration.
 *
 * The server owns the value — it is the same for every tab and every device —
 * and this store only caches the last answer so the UI does not fetch it once
 * per component. One read is in flight at a time; a save publishes its result
 * to every subscriber.
 */
export interface LiteConfigSnapshot {
  config: LiteConfig;
  /** Ranges from the server, so a client never duplicates them. */
  bounds: LiteConfigBounds;
  /** False until the first server read has answered. */
  loaded: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  /** The last failure, from a read or a save. */
  error: string | null;
}

const INITIAL_SNAPSHOT: LiteConfigSnapshot = {
  config: DEFAULT_LITE_CONFIG,
  bounds: LITE_CONFIG_BOUNDS,
  loaded: false,
  saving: false,
  error: null,
};

let snapshot: LiteConfigSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();
let readInFlight: Promise<void> | null = null;

function publish(next: LiteConfigSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function errorMessage(body: unknown, fallback: string): string {
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === "string" && message ? message : fallback;
}

function validBounds(input: unknown, fallback: LiteValueBounds): LiteValueBounds {
  const record = (input ?? {}) as Record<string, unknown>;
  const pick = (key: "min" | "max" | "default"): number => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : fallback[key];
  };
  const bounds = { min: pick("min"), max: pick("max"), default: pick("default") };
  return bounds.min > bounds.max ? fallback : bounds;
}

function parseBounds(value: unknown): LiteConfigBounds {
  const body = value as {
    bounds?: { idleMinutes?: unknown; memoryTargetMiB?: unknown };
  } | null;
  return {
    idleMinutes: validBounds(body?.bounds?.idleMinutes, LITE_CONFIG_BOUNDS.idleMinutes),
    memoryTargetMiB: validBounds(body?.bounds?.memoryTargetMiB, LITE_CONFIG_BOUNDS.memoryTargetMiB),
  };
}

export function getLiteConfigSnapshot(): LiteConfigSnapshot {
  return snapshot;
}

/** Server-rendered markup reads the default; the first client read replaces it. */
export function getLiteConfigServerSnapshot(): LiteConfigSnapshot {
  return INITIAL_SNAPSHOT;
}

export function subscribeLiteConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget everything this page has read or saved. */
export function resetLiteConfigStore(): void {
  snapshot = INITIAL_SNAPSHOT;
  readInFlight = null;
  listeners.clear();
}

/**
 * Read the configuration once, sharing one request between every caller. A
 * failure keeps the last known values and reports why, so a momentary error
 * cannot silently present the wrong mode.
 */
export function refreshLiteConfig(): Promise<void> {
  if (readInFlight) return readInFlight;
  readInFlight = (async () => {
    try {
      const response = await fetch("/api/lite", { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(body, `HTTP ${response.status}`));
      publish({
        config: coerceLiteConfig(body),
        bounds: parseBounds(body),
        loaded: true,
        saving: snapshot.saving,
        error: null,
      });
    } catch (error) {
      publish({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
    } finally {
      readInFlight = null;
    }
  })();
  return readInFlight;
}

/**
 * Persist a change and publish the stored result — the server answers with the
 * whole configuration, so no guess about what the file ended up holding.
 */
export async function saveLiteConfig(patch: Partial<LiteConfig>): Promise<boolean> {
  publish({ ...snapshot, saving: true, error: null });
  try {
    const response = await fetch("/api/lite", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(body, `HTTP ${response.status}`));
    publish({
      config: coerceLiteConfig(body),
      bounds: parseBounds(body),
      loaded: true,
      saving: false,
      error: null,
    });
    return true;
  } catch (error) {
    publish({ ...snapshot, saving: false, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
