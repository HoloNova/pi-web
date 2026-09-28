// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { getClientId } from "./client-identity";
import { isLiteModeEnabled } from "./lite-mode-preference";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  // The page identity lets the server treat a real command as a liveness claim
  // from this tab, so a concurrent Lite-mode reclaim cannot tear down a session
  // the tab is starting to use again. The Lite flag is sent only from a Lite
  // tab, so normal mode never creates server-side presence. Absent off-browser.
  const clientId = getClientId();
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(clientId ? { "x-pi-web-client": clientId } : {}),
      ...(clientId && isLiteModeEnabled() ? { "x-pi-web-lite": "1" } : {}),
    },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}
