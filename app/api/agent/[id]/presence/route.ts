import { NextResponse } from "next/server";
import { readLiteConfig } from "@/lib/lite-config-settings";
import { acquireSessionPresence, hasActiveSessionPresence, releaseSessionPresence } from "@/lib/session-liveness";
import { isApiRequestAllowed } from "@/lib/request-security";

const PRESENCE_ACTIONS = new Set(["acquire", "renew", "release"]);
const MAX_CLIENT_ID_LENGTH = 128;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/agent/[id]/presence
 *
 * One presence entry per page that is holding a session (`clientId`), so one
 * page releasing a session never closes a wrapper another page or device is
 * still using. `release` also lets the server reclaim the wrapper as soon as
 * nothing is viewed and nothing is running.
 *
 * Presence is a Lite-mode concept — it is what decides whether an idle session
 * may be reclaimed — so it is refused while the instance runs in normal mode,
 * where the existing connection lease already governs session lifetime. The
 * mode comes from the server's own configuration, never from the request.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // A release can close a session, so this goes through the same request
  // security every other state-changing route uses.
  if (!isApiRequestAllowed(req)) {
    return errorResponse("Untrusted API request", 403);
  }
  if (!readLiteConfig().enabled) {
    return errorResponse("Session presence applies to Lite mode only", 409);
  }

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
    // Releasing notifies the reclaim listener in lib/rpc-manager.ts, which
    // closes the wrapper once no viewer and no running work remain.
    releaseSessionPresence(id, clientId);
  } else {
    acquireSessionPresence(id, clientId);
  }

  return NextResponse.json({
    success: true,
    viewed: hasActiveSessionPresence(id),
  }, { headers: { "Cache-Control": "no-store" } });
}
