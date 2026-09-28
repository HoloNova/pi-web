import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });
  // The page identity lets a Lite tab release its own SSE lease together with
  // its presence, without touching another tab's connection to the same session.
  const clientId = new URL(req.url).searchParams.get("client")?.trim() ?? "";

  // Fast path: already-running session
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive() && !session.isClosing()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }

  const stream = createAgentEventStream(req, id, sessionPromise, clientId);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
