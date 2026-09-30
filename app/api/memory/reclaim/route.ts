import { NextResponse } from "next/server";
import { readLiteConfig } from "@/lib/lite-config-settings";
import { isApiRequestAllowed } from "@/lib/request-security";
import { runMemoryPressureReclaim } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/memory/reclaim — close the oldest idle session, once.
 *
 * This is the only thing that acts on memory pressure, and it does so on
 * request: `GET /api/memory` reports, the settings button and an over-target
 * page ask for a pass here. A pass closes at most one session (`RECLAIM_PASS_LIMIT`),
 * never a running task or delegated child, never a session another tab or
 * device is viewing, and it reports what it saw either way. Nothing is killed
 * and systemd is never touched; an instance that cannot free anything simply
 * stays over target and says so.
 *
 * The target only applies in Lite mode, so a normal-mode instance refuses the
 * pass rather than closing sessions its operator never asked to have closed.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!readLiteConfig().enabled) {
    return NextResponse.json(
      { error: "The memory target is a Lite-mode-only setting" },
      { status: 409, headers: NO_STORE },
    );
  }
  try {
    return NextResponse.json(runMemoryPressureReclaim(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
