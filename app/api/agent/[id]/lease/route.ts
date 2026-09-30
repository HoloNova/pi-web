import { NextResponse } from "next/server";
import { renewSessionLivenessLeases } from "@/lib/session-liveness";

// POST /api/agent/[id]/lease - Renew selected-session SSE leases.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // A page renews its own leases only, so one tab can never keep another
  // tab's presence alive. A caller that sends no identity (a non-browser
  // client) keeps the old behaviour and renews every lease for the session.
  const clientId = new URL(req.url).searchParams.get("client")?.trim() || undefined;
  return NextResponse.json({
    success: true,
    renewed: renewSessionLivenessLeases(id, clientId),
  }, { headers: { "Cache-Control": "no-store" } });
}
