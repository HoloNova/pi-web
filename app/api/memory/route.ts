import { NextResponse } from "next/server";
import { isLiteRequest } from "@/lib/lite-request";
import {
  DEFAULT_MEMORY_TARGET_MIB,
  MAX_MEMORY_TARGET_MIB,
  MEMORY_BYTES_PER_MIB,
  MEMORY_NEAR_TARGET_RATIO,
  MIN_MEMORY_TARGET_MIB,
  isValidMemoryTargetMiB,
  memoryPressureState,
  shouldReclaimForMemoryState,
} from "@/lib/memory-target";
import { readMemoryTargetMiB, writeMemoryTargetMiB } from "@/lib/memory-target-settings";
import { readServiceMemoryReading } from "@/lib/service-memory";
import { runMemoryPressureReclaim } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function targetBounds() {
  return {
    defaultMiB: DEFAULT_MEMORY_TARGET_MIB,
    minMiB: MIN_MEMORY_TARGET_MIB,
    maxMiB: MAX_MEMORY_TARGET_MIB,
    nearRatio: MEMORY_NEAR_TARGET_RATIO,
  };
}

/**
 * GET /api/memory
 *
 * Current service footprint vs the stored target. The footprint is read
 * read-only (cgroup v2 first, Node RSS as a labelled fallback). A Lite request
 * also runs one bounded pressure pass: near or over target, it reclaims the
 * oldest idle sessions through the milestone-1 path. A normal-mode request
 * reports the inactive shape instead: the target is a Lite-mode-only concept,
 * so there is no target, state, or usage to report and no reclaim to run. The
 * stored value stays on disk but is inert while Lite mode is off.
 */
export async function GET(req: Request) {
  if (!isLiteRequest(req)) {
    return NextResponse.json({ active: false }, { headers: NO_STORE });
  }
  try {
    const targetMiB = readMemoryTargetMiB();
    const reading = readServiceMemoryReading();
    const state = memoryPressureState(reading.bytes, targetMiB);
    const reclaim = shouldReclaimForMemoryState(state)
      ? runMemoryPressureReclaim()
      : null;
    return NextResponse.json({
      active: true,
      targetMiB,
      ...targetBounds(),
      usedBytes: reading.bytes,
      usedMiB: Math.round(reading.bytes / MEMORY_BYTES_PER_MIB),
      state,
      source: reading.source,
      approximate: reading.approximate,
      detail: reading.detail,
      reclaim,
    }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * PUT /api/memory — persist a new service-wide target in MiB. Lite mode only:
 * without the Lite header the target does not apply, so the write is refused.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!isLiteRequest(req)) {
    return NextResponse.json(
      { error: "The memory target is a Lite-mode-only setting" },
      { status: 409, headers: NO_STORE },
    );
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415, headers: NO_STORE },
    );
  }
  try {
    const body = await req.json() as { targetMiB?: unknown };
    if (!isValidMemoryTargetMiB(body.targetMiB)) {
      return NextResponse.json({
        error: `targetMiB must be a whole number between ${MIN_MEMORY_TARGET_MIB} and ${MAX_MEMORY_TARGET_MIB}`,
      }, { status: 400, headers: NO_STORE });
    }
    const targetMiB = writeMemoryTargetMiB(body.targetMiB);
    return NextResponse.json({ targetMiB, ...targetBounds() }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
