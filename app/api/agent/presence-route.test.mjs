import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import(join(process.cwd(), "app/api/agent/[id]/presence/route.ts"));
const { hasActiveSessionPresence } = await jiti.import(join(process.cwd(), "lib/session-liveness.ts"));

const sessionId = "presence-route-session";
const routeContext = { params: Promise.resolve({ id: sessionId }) };

function request(body) {
  return new Request(`http://localhost/api/agent/${sessionId}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("acquire, renew and release drive per-tab presence", async () => {
  let response = await POST(request({ clientId: "tab-a", action: "acquire" }), routeContext);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, viewed: true });
  assert.equal(hasActiveSessionPresence(sessionId), true);

  response = await POST(request({ clientId: "tab-a", action: "renew" }), routeContext);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).viewed, true);

  // A second tab does not replace the first.
  await POST(request({ clientId: "tab-b", action: "acquire" }), routeContext);
  await POST(request({ clientId: "tab-a", action: "release" }), routeContext);
  assert.equal(hasActiveSessionPresence(sessionId), true);

  response = await POST(request({ clientId: "tab-b", action: "release" }), routeContext);
  assert.equal((await response.json()).viewed, false);
  assert.equal(hasActiveSessionPresence(sessionId), false);
});

test("rejects a missing client id, an unknown action and invalid JSON", async () => {
  assert.equal((await POST(request({ action: "acquire" }), routeContext)).status, 400);
  assert.equal((await POST(request({ clientId: "  ", action: "acquire" }), routeContext)).status, 400);
  assert.equal((await POST(request({ clientId: "tab-a", action: "bogus" }), routeContext)).status, 400);

  const invalid = new Request(`http://localhost/api/agent/${sessionId}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  });
  assert.equal((await POST(invalid, routeContext)).status, 400);
});
