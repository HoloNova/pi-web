import { NextResponse } from "next/server";
import { MEMORY_BYTES_PER_MIB, MEMORY_NEAR_TARGET_RATIO, memoryPressureState } from "@/lib/memory-pressure";
import { readLiteConfig } from "@/lib/lite-config-settings";
import { readServiceMemoryReading } from "@/lib/service-memory";
import { collectMemoryReclaimCandidates } from "@/lib/rpc-manager";
import { planIdleReclaim } from "@/lib/lite-memory-reclaim";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/memory
 *
 * The service footprint against the instance's memory target. **Read-only**: it
 * measures, and it counts what a reclaim pass *could* close, but it never
 * closes anything — a plain read must not change how the service behaves.
 * Closing a session is `POST /api/memory/reclaim`.
 *
 * The target is part of Lite mode's configuration and only applies there, so a
 * normal-mode instance reports the inactive shape: no target, no state, no
 * usage to speak of. The stored number stays on disk and is inert.
 */
export async function GET() {
  try {
    const config = readLiteConfig();
    if (!config.enabled) {
      return NextResponse.json({ active: false }, { headers: NO_STORE });
    }
    const reading = readServiceMemoryReading();
    const targetMiB = config.memoryTargetMiB;
    const state = memoryPressureState(reading.bytes, targetMiB);
    const plan = planIdleReclaim(collectMemoryReclaimCandidates());
    return NextResponse.json({
      active: true,
      targetMiB,
      nearRatio: MEMORY_NEAR_TARGET_RATIO,
      usedBytes: reading.bytes,
      usedMiB: Math.round(reading.bytes / MEMORY_BYTES_PER_MIB),
      state,
      source: reading.source,
      approximate: reading.approximate,
      detail: reading.detail,
      /** Idle, unviewed sessions a reclaim pass could close right now. */
      idleSessions: plan.reclaim.length,
    }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
