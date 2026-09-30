import { NextResponse } from "next/server";
import { MEMORY_BYTES_PER_MIB, MEMORY_NEAR_TARGET_RATIO, memoryPressureState } from "@/lib/memory-pressure";
import { readLiteConfig } from "@/lib/lite-config-settings";
import { readServiceMemoryReading } from "@/lib/service-memory";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/memory
 *
 * The service footprint against the instance's memory target. **Read-only, and
 * cheap**: it reads the configuration, measures the service and compares the two.
 * It never closes anything and never walks sessions — the policy that acts on
 * pressure is the server's own monitor (lib/lite-memory-monitor.ts), which runs
 * whether or not a page is open.
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
    }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
