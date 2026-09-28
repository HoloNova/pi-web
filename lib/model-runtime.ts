import { join } from "path";
import {
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/**
 * ModelRuntime that also includes providers registered by extensions (an
 * extension that calls `registerProvider` / `createProvider` during resource
 * loading). A bare `ModelRuntime.create()` only knows built-in providers plus
 * models.json, so extension-registered providers were invisible to the
 * provider-listing and auth routes.
 *
 * The agent dir acts as cwd so project-local extensions stay out; global
 * package extensions always load. Not cached: these routes need fresh
 * credentials for auth status and login/logout to be truthful.
 */
export async function createModelRuntimeWithExtensions(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
  return services.modelRuntime;
}

/**
 * ModelRuntime with pi's built-in providers plus `~/.pi/agent/models.json`, and
 * nothing else.
 *
 * Lite mode's settings reads use this so they never import the configured
 * extensions; loading them was the whole cost of listing providers (an
 * extension such as AFT spawns a helper process per load, and three provider
 * reads meant three processes). The paths match what
 * `createAgentSessionServices()` builds, minus the resource loader, so auth
 * status and login read the same credential store.
 *
 * The trade: a provider an extension registers at runtime is invisible here.
 * This runtime must therefore never decide what to *write* — every
 * `enabledModels` edit resolves against the full runtime, which is also what
 * keeps a plugin-registered model from being dropped out of the scope. See
 * `app/api/models/enabled/route.ts`.
 */
export async function createLiteModelRuntime(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
}
