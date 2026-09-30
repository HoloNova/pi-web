import { NextResponse } from "next/server";
import {
  LITE_CONFIG_BOUNDS,
  MAX_LITE_IDLE_MINUTES,
  MAX_MEMORY_TARGET_MIB,
  MIN_LITE_IDLE_MINUTES,
  MIN_MEMORY_TARGET_MIB,
  isValidLiteIdleMinutes,
  isValidMemoryTargetMiB,
  type LiteConfig,
} from "@/lib/lite-config";
import { readLiteConfig, writeLiteConfig, type LiteConfigPatch } from "@/lib/lite-config-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function view(config: LiteConfig) {
  return { ...config, bounds: LITE_CONFIG_BOUNDS };
}

/**
 * GET /api/lite
 *
 * The instance's Lite configuration. Observation only: it never writes, never
 * reclaims, and never closes a session — a read cannot change how the service
 * behaves. The bounds travel with the values so a client can validate before it
 * saves instead of duplicating the ranges.
 */
export async function GET() {
  try {
    return NextResponse.json(view(readLiteConfig()), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * PUT /api/lite — change the instance-wide Lite configuration.
 *
 * A partial update: only the fields in the body change, the rest keep their
 * stored values. Changing configuration is a real mutation, so it goes through
 * the same request-security check every other mutating route uses; there is no
 * Lite-specific authentication beyond that.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415, headers: NO_STORE },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400, headers: NO_STORE });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400, headers: NO_STORE });
  }

  const input = body as Record<string, unknown>;
  const patch: LiteConfigPatch = {};
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400, headers: NO_STORE });
    }
    patch.enabled = input.enabled;
  }
  if ("idleMinutes" in input) {
    if (!isValidLiteIdleMinutes(input.idleMinutes)) {
      return NextResponse.json({
        error: `idleMinutes must be a whole number between ${MIN_LITE_IDLE_MINUTES} and ${MAX_LITE_IDLE_MINUTES}`,
      }, { status: 400, headers: NO_STORE });
    }
    patch.idleMinutes = input.idleMinutes;
  }
  if ("memoryTargetMiB" in input) {
    if (!isValidMemoryTargetMiB(input.memoryTargetMiB)) {
      return NextResponse.json({
        error: `memoryTargetMiB must be a whole number between ${MIN_MEMORY_TARGET_MIB} and ${MAX_MEMORY_TARGET_MIB}`,
      }, { status: 400, headers: NO_STORE });
    }
    patch.memoryTargetMiB = input.memoryTargetMiB;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({
      error: "Provide at least one of enabled, idleMinutes, memoryTargetMiB",
    }, { status: 400, headers: NO_STORE });
  }

  try {
    return NextResponse.json(view(writeLiteConfig(patch)), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
