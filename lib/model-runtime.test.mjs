import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Checks for the extension-release wrapper.
 *
 * The coding-agent package is aliased to a stub, so these tests prove the order
 * (shutdown event before dispose), the session's shape (in memory, no tools) and
 * the failure handling without loading a real extension.
 */
const SDK_STUB = `
export const calls = globalThis.__piWebSdkCalls ?? (globalThis.__piWebSdkCalls = []);
export function getAgentDir() { return globalThis.__piWebAgentDir ?? "/tmp/pi-web-test-agent"; }
export class ModelRuntime {
  static async create(options) {
    calls.push({ call: "ModelRuntime.create", options });
    return { kind: "lite" };
  }
}
export function createAgentSessionServices(options) {
  calls.push({ call: "createAgentSessionServices", options });
  return Promise.resolve({
    modelRuntime: { kind: "runtime" },
    settingsManager: { kind: "settings" },
    resourceLoader: { kind: "loader" },
  });
}
export const SessionManager = {
  inMemory(cwd) {
    calls.push({ call: "SessionManager.inMemory", cwd });
    return { kind: "in-memory-session-manager" };
  },
};
export function createAgentSessionFromServices(options) {
  calls.push({
    call: "createAgentSessionFromServices",
    sessionManager: options.sessionManager,
    noTools: options.noTools,
  });
  if (globalThis.__piWebSessionFails) return Promise.reject(new Error("cannot create session"));
  const session = {
    extensionRunner: {
      emit(event) {
        calls.push({ call: "emit", event });
        if (globalThis.__piWebShutdownThrows) return Promise.reject(new Error("handler failed"));
        if (globalThis.__piWebShutdownHangs) return new Promise(() => {});
        return Promise.resolve();
      },
    },
    dispose() {
      calls.push({ call: "dispose" });
    },
  };
  globalThis.__piWebSession = session;
  return Promise.resolve({ session });
}
`;

/** Write the instance's Lite configuration where the settings module reads it. */
async function writeLiteSettings(enabled, extensionModels) {
  await writeFile(
    join(globalThis.__piWebAgentDir, "pi-web-settings.json"),
    JSON.stringify({ version: 1, lite: { enabled, idleMinutes: 5, memoryTargetMiB: 1800, extensionModels } }),
    "utf8",
  );
}

async function makeJiti() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-model-runtime-"));
  const stubPath = join(dir, "pi-coding-agent-stub.mjs");
  await writeFile(stubPath, SDK_STUB, "utf8");
  // A fresh agent dir per test: lib/lite-config-settings.ts reads the Lite
  // configuration from `getAgentDir()/pi-web-settings.json`.
  const agentDir = join(dir, "agent");
  await mkdir(agentDir, { recursive: true });
  globalThis.__piWebAgentDir = agentDir;
  globalThis.__piWebSdkCalls = [];
  delete globalThis.__piWebSessionFails;
  delete globalThis.__piWebShutdownThrows;
  delete globalThis.__piWebShutdownHangs;
  const jiti = createJiti(import.meta.url, {
    alias: { "@earendil-works/pi-coding-agent": stubPath },
    tsconfigPaths: true,
    interopDefault: true,
    moduleCache: false,
  });
  return { jiti, calls: () => globalThis.__piWebSdkCalls };
}

const callNames = (calls) => calls.map((entry) => (typeof entry === "string" ? entry : entry.call));

test("a read runs against the extension runtime and releases it afterwards", async () => {
  const { jiti, calls } = await makeJiti();
  const { withExtensionServices } = await jiti.import("./model-runtime.ts");

  const value = await withExtensionServices({ cwd: "/project" }, async (services) => {
    assert.equal(services.modelRuntime.kind, "runtime");
    return `read:${services.modelRuntime.kind}`;
  });

  assert.equal(value, "read:runtime");
  const recorded = calls();
  // The session exists only to carry session_shutdown, so it must not be able to
  // write a session file (in memory) or run a tool.
  const sessionCall = recorded.find((entry) => entry.call === "createAgentSessionFromServices");
  assert.deepEqual(sessionCall.sessionManager, { kind: "in-memory-session-manager" });
  assert.equal(sessionCall.noTools, "all");
  assert.deepEqual(callNames(recorded), [
    "createAgentSessionServices",
    "SessionManager.inMemory",
    "createAgentSessionFromServices",
    "emit",
    "dispose",
  ]);
  // Extensions are told *before* the session is torn down, which is the only
  // moment their cleanup handlers can run.
  const emitCall = recorded.find((entry) => entry.call === "emit");
  assert.equal(emitCall.event.type, "session_shutdown");
});

test("a failing read still releases what loading the extensions started", async () => {
  const { jiti, calls } = await makeJiti();
  const { withExtensionServices } = await jiti.import("./model-runtime.ts");

  await assert.rejects(
    withExtensionServices({ cwd: "/project" }, async () => {
      throw new Error("read failed");
    }),
    /read failed/,
  );
  assert.deepEqual(callNames(calls()).slice(-2), ["emit", "dispose"]);
});

test("a shutdown handler that throws does not stop the dispose", async () => {
  const { jiti, calls } = await makeJiti();
  const { withExtensionServices } = await jiti.import("./model-runtime.ts");
  globalThis.__piWebShutdownThrows = true;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(await withExtensionServices({ cwd: "/project" }, async () => "ok"), "ok");
  } finally {
    console.error = realError;
  }
  assert.deepEqual(callNames(calls()).slice(-2), ["emit", "dispose"]);
  // Not `errors[0]`: Node can route its own warnings through the patched
  // console.error first, so the assertion checks that ours was logged at all.
  assert.match(errors.map((args) => String(args[0])).join("\n"), /session_shutdown before dispose failed/);
});

test("a shutdown handler that never finishes does not hold the read", async (t) => {
  const { jiti, calls } = await makeJiti();
  const { withExtensionServices } = await jiti.import("./model-runtime.ts");
  globalThis.__piWebShutdownHangs = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  let result;
  try {
    const reading = withExtensionServices({ cwd: "/project" }, async () => "ok");
    // Let the release path reach its race before the clock moves.
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5_000);
    result = await reading;
  } finally {
    console.error = realError;
  }
  assert.equal(result, "ok");
  // Disposed anyway: a stuck plugin must not leak the session it was given.
  assert.deepEqual(callNames(calls()).slice(-2), ["emit", "dispose"]);
  assert.match(errors.map((args) => String(args[0])).join("\n"), /did not finish session_shutdown within 5000ms/);
});

test("a read still works when the release session cannot be created", async () => {
  const { jiti, calls } = await makeJiti();
  const { withExtensionServices } = await jiti.import("./model-runtime.ts");
  globalThis.__piWebSessionFails = true;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  let value;
  try {
    value = await withExtensionServices({ cwd: "/project" }, async () => "still answered");
  } finally {
    console.error = realError;
  }
  assert.equal(value, "still answered");
  assert.deepEqual(callNames(calls()), [
    "createAgentSessionServices",
    "SessionManager.inMemory",
    "createAgentSessionFromServices",
  ]);
  assert.match(errors.map((args) => String(args[0])).join("\n"), /could not create a session to release extension resources/);
});

test("withExtensionRuntime reads the runtime from the agent dir", async () => {
  const { jiti, calls } = await makeJiti();
  const { withExtensionRuntime } = await jiti.import("./model-runtime.ts");
  const value = await withExtensionRuntime(async (runtime) => runtime.kind);
  assert.equal(value, "runtime");
  const servicesCall = calls()[0];
  // The agent dir acts as cwd: project-local extensions stay out.
  assert.deepEqual(servicesCall.options, {
    cwd: globalThis.__piWebAgentDir,
    agentDir: globalThis.__piWebAgentDir,
  });
});

test("every route that enumerates models or providers goes through the wrapper", async () => {
  const sources = await Promise.all([
    "app/api/models/route.ts",
    "app/api/models/enabled/route.ts",
    "app/api/models/default/route.ts",
    "app/api/auth/providers/route.ts",
    "app/api/auth/api-key/[provider]/route.ts",
    "app/api/auth/login/[provider]/route.ts",
    "app/api/auth/logout/[provider]/route.ts",
    "lib/model-catalog-refresh.ts",
  ].map((path) => readFile(join(process.cwd(), path), "utf8")));

  // Comments explain the rule (and name the function); only code is checked.
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const source of sources) {
    const code = stripComments(source);
    // Building these services loads every configured extension, and only the
    // wrappers release them again; a direct call is the bug this file guards.
    // `withCatalogRuntime()` is the same wrappers with the Lite catalogue
    // choice in front of them.
    assert.doesNotMatch(code, /createAgentSessionServices\(/);
    assert.match(code, /with(Extension(Services|Runtime)|CatalogRuntime)\(/);
  }
});

test("the Lite catalogue path loads no extension and builds no session", async () => {
  const { jiti, calls } = await makeJiti();
  const { withCatalogRuntime } = await jiti.import("./model-runtime.ts");
  await writeLiteSettings(true, false);

  const value = await withCatalogRuntime(async (runtime) => runtime.kind);

  assert.equal(value, "lite");
  // ModelRuntime.create() and nothing else: no services, no release session,
  // because nothing was loaded that would need releasing.
  assert.deepEqual(callNames(calls()), ["ModelRuntime.create"]);
});

test("the switch puts the same read back on the extension catalogue", async () => {
  const { jiti, calls } = await makeJiti();
  const { withCatalogRuntime } = await jiti.import("./model-runtime.ts");
  await writeLiteSettings(true, true);

  await withCatalogRuntime(async (runtime) => runtime.kind);

  // The full catalogue, released again when the read is done.
  assert.deepEqual(callNames(calls()), [
    "createAgentSessionServices",
    "SessionManager.inMemory",
    "createAgentSessionFromServices",
    "emit",
    "dispose",
  ]);
});
