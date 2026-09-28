import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Route checks for GET/PUT /api/memory. The agent dir and the cgroup memory
 * file are both redirected to a temp location, so the test never reads the real
 * service cgroup and never writes the operator's settings.
 */
const workDir = await mkdtemp(join(tmpdir(), "pi-web-memory-route-"));
const agentDir = join(workDir, "agent");
const cgroupFile = join(workDir, "memory.current");
await writeFile(cgroupFile, "3000000000\n");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_MEMORY_CGROUP_PATH = cgroupFile;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import(join(process.cwd(), "app/api/memory/route.ts"));
const { AgentSessionWrapper, reclaimIdleRpcSession } = await jiti.import(join(process.cwd(), "lib/rpc-manager.ts"));
const { acquireSessionPresence, releaseSessionPresence } = await jiti.import(join(process.cwd(), "lib/session-liveness.ts"));
const { MEMORY_TARGET_FILE_NAME } = await jiti.import(join(process.cwd(), "lib/memory-target-settings.ts"));

const LITE_HEADER = { "x-pi-web-lite": "1" };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeInner(sessionId) {
  return {
    sessionId,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: { async emit() {} },
    sessionManager: {
      getCwd: () => "/tmp",
      getSessionFile: () => undefined,
      getHeader: () => undefined,
      getEntries: () => [],
    },
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: () => Promise.resolve(),
    subscribe: () => () => {},
    dispose() {},
  };
}

function registerWrapper(t, wrapper) {
  reclaimIdleRpcSession("__warmup__");
  const sessionId = wrapper.sessionId;
  globalThis.__piSessions.set(sessionId, wrapper);
  t.after(() => {
    if (globalThis.__piSessions.get(sessionId) === wrapper) globalThis.__piSessions.delete(sessionId);
    wrapper.destroy();
  });
  return sessionId;
}

function liteRequest() {
  return new Request("http://localhost/api/memory", { headers: LITE_HEADER });
}

function getRequest() {
  return new Request("http://localhost/api/memory");
}

test("a normal-mode read reports usage and never reclaims", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner("memory-route-normal"));
  wrapper.start();
  registerWrapper(t, wrapper);

  const response = await GET(getRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.targetMiB, 1500);
  assert.equal(body.defaultMiB, 1500);
  assert.equal(body.usedBytes, 3000000000);
  assert.equal(body.state, "over");
  assert.equal(body.source, "cgroup");
  assert.equal(body.approximate, false);
  assert.equal(body.detail, cgroupFile);
  assert.equal(body.reclaim, null);

  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isClosing(), false);
});

test("a Lite read over target reclaims the oldest idle session first", async (t) => {
  const older = new AgentSessionWrapper(makeInner("memory-route-older"));
  older.start();
  registerWrapper(t, older);
  await sleep(3);
  const newer = new AgentSessionWrapper(makeInner("memory-route-newer"));
  newer.start();
  registerWrapper(t, newer);

  const body = await (await GET(liteRequest())).json();
  assert.equal(body.state, "over");
  assert.equal(body.reclaim.reclaimable, 2);
  assert.deepEqual(body.reclaim.reclaimed, ["memory-route-older", "memory-route-newer"]);

  await nextTurn();
  assert.equal(older.isAlive(), false);
  assert.equal(newer.isAlive(), false);
});

test("over target with nothing reclaimable reports over target and closes nothing", async (t) => {
  const runningInner = makeInner("memory-route-running");
  let sdkListener;
  runningInner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const running = new AgentSessionWrapper(runningInner);
  running.start();
  registerWrapper(t, running);
  runningInner.isStreaming = true;
  sdkListener({ type: "agent_start" });

  const viewed = new AgentSessionWrapper(makeInner("memory-route-viewed"));
  viewed.start();
  registerWrapper(t, viewed);
  acquireSessionPresence("memory-route-viewed", "tab-a");
  t.after(() => releaseSessionPresence("memory-route-viewed", "tab-a"));

  const body = await (await GET(liteRequest())).json();
  assert.equal(body.state, "over");
  assert.deepEqual(body.reclaim.reclaimed, []);
  assert.equal(body.reclaim.reclaimable, 0);
  assert.equal(body.reclaim.running, 1);
  assert.equal(body.reclaim.viewed, 1);

  await nextTurn();
  assert.equal(running.isAlive(), true);
  assert.equal(viewed.isAlive(), true);
});

test("PUT validates and persists the service-wide target", async () => {
  const put = (body, headers = { "Content-Type": "application/json" }) => PUT(new Request("http://localhost/api/memory", {
    method: "PUT",
    headers: { host: "localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

  for (const invalid of [{ targetMiB: 0 }, { targetMiB: 1500.5 }, { targetMiB: "1500" }, { targetMiB: 99_999 }, {}]) {
    const response = await put(invalid);
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }
  assert.equal((await put({ targetMiB: 2048 }, {})).status, 415);
  assert.equal((await put("not json")).status, 500);

  const saved = await put({ targetMiB: 2048 });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.targetMiB, 2048);
  assert.equal(savedBody.minMiB, 256);
  assert.equal(savedBody.maxMiB, 16384);

  const stored = JSON.parse(await readFile(join(agentDir, MEMORY_TARGET_FILE_NAME), "utf8"));
  assert.equal(stored.targetMiB, 2048);
  assert.equal(stored.version, 1);

  const status = await (await GET(getRequest())).json();
  assert.equal(status.targetMiB, 2048);
});
