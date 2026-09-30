import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Stub of the coding-agent package that records which factory `lib/model-runtime.ts`
// reaches for. Aliasing the bare specifier proves the Lite path never calls
// `createAgentSessionServices()` — and therefore never loads an extension —
// without importing the real SDK.
const SDK_STUB = `
export const calls = [];
export function createAgentSessionServices() {
  calls.push("createAgentSessionServices");
  return { modelRuntime: { kind: "full" } };
}
export function getAgentDir() { return "/tmp/pi-web-test-agent"; }
export class ModelRuntime {
  static async create(options) {
    calls.push({ factory: "ModelRuntime.create", options });
    return { kind: "lite" };
  }
}
`;

test("the Lite runtime is ModelRuntime.create and never loads extensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-model-runtime-"));
  const stubPath = join(dir, "pi-coding-agent-stub.mjs");
  await writeFile(stubPath, SDK_STUB, "utf8");

  const jiti = createJiti(import.meta.url, {
    alias: { "@earendil-works/pi-coding-agent": stubPath },
    interopDefault: true,
    moduleCache: false,
  });
  const { createLiteModelRuntime, createModelRuntimeWithExtensions } = await jiti.import("./model-runtime.ts");
  const stub = await jiti.import(stubPath);

  assert.deepEqual(await createLiteModelRuntime(), { kind: "lite" });
  // The same credential and models.json paths createAgentSessionServices()
  // builds, minus the resource loader that imports extensions.
  assert.deepEqual(stub.calls, [{
    factory: "ModelRuntime.create",
    options: {
      authPath: "/tmp/pi-web-test-agent/auth.json",
      modelsPath: "/tmp/pi-web-test-agent/models.json",
    },
  }]);

  // The normal path is unchanged: it still builds the runtime from services.
  assert.deepEqual(await createModelRuntimeWithExtensions(), { kind: "full" });
  assert.deepEqual(
    stub.calls.map((call) => (typeof call === "string" ? call : call.factory)),
    ["ModelRuntime.create", "createAgentSessionServices"],
  );
});
