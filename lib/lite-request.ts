import { isLiteModeEnabled } from "./lite-mode-preference";

/**
 * How a Lite-mode tab tells the server that a request must not load
 * extensions. Milestone 1 introduced the header for agent commands; the
 * model-settings and provider reads reuse it so they can pick a runtime that
 * skips the extension set (an extension such as AFT spawns a helper process
 * per load).
 *
 * It is a per-request signal, never a server setting: a normal-mode tab sends
 * nothing and keeps the full runtime, and one tab's choice never reaches
 * another device.
 */
export const LITE_MODE_REQUEST_HEADER = "x-pi-web-lite";
export const LITE_MODE_REQUEST_VALUE = "1";

/** Headers for a browser fetch; empty unless this tab has Lite mode on. */
export function liteModeRequestHeaders(): Record<string, string> {
  return isLiteModeEnabled() ? { [LITE_MODE_REQUEST_HEADER]: LITE_MODE_REQUEST_VALUE } : {};
}

/** Server-side check for the same header. */
export function isLiteRequest(req: Request): boolean {
  return req.headers.get(LITE_MODE_REQUEST_HEADER) === LITE_MODE_REQUEST_VALUE;
}
