import { NextResponse } from "next/server";
import { reclaimIdleRpcSession } from "@/lib/rpc-manager";
import { acquireSessionPresence, hasActiveSessionPresence, releaseSessionPresence } from "@/lib/session-liveness";

const PRESENCE_ACTIONS = new Set(["acquire", "renew", "release"]);
const MAX_CLIENT_ID_LENGTH = 128;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/agent/[id]/presence
 *
 * Lite mode keeps one presence entry per browser tab that is holding the
 * session (`clientId`), so one tab releasing the session never closes a wrapper
 * another tab is using.
 * `release` also asks the server to reclaim the wrapper promptly when no
 * viewer and no running task remain.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { clientId?: unknown; action?: unknown };
  try {
    body = (await req.json()) as { clientId?: unknown; action?: unknown };
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!clientId || clientId.length > MAX_CLIENT_ID_LENGTH) {
    return errorResponse("clientId is required", 400);
  }
  if (!PRESENCE_ACTIONS.has(action)) {
    return errorResponse(`Unknown presence action: ${action || "(missing)"}`, 400);
  }

  if (action === "release") {
    releaseSessionPresence(id, clientId);
    reclaimIdleRpcSession(id);
  } else {
    acquireSessionPresence(id, clientId);
  }

  return NextResponse.json({
    success: true,
    viewed: hasActiveSessionPresence(id),
  }, { headers: { "Cache-Control": "no-store" } });
}
