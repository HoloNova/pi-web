import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

test("a Lite tab sends the header and a normal tab sends nothing", async (t) => {
  delete globalThis.window;
  const { LITE_MODE_REQUEST_HEADER, liteModeRequestHeaders, isLiteRequest } = await jiti.import("./lite-request.ts");
  assert.equal(LITE_MODE_REQUEST_HEADER, "x-pi-web-lite");
  assert.deepEqual(liteModeRequestHeaders(), {});

  globalThis.window = { localStorage: { getItem: () => "1", setItem() {} } };
  t.after(() => { delete globalThis.window; });
  assert.deepEqual(liteModeRequestHeaders(), { "x-pi-web-lite": "1" });

  assert.equal(isLiteRequest(new Request("http://localhost/x", { headers: { "x-pi-web-lite": "1" } })), true);
  assert.equal(isLiteRequest(new Request("http://localhost/x")), false);
  // Anything but the exact value is normal mode, so a stray header is harmless.
  assert.equal(isLiteRequest(new Request("http://localhost/x", { headers: { "x-pi-web-lite": "0" } })), false);
});
