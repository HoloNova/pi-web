import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/**
 * How long a read waits for extensions to finish their `session_shutdown`
 * handlers before the session is disposed anyway. A handler that hangs must not
 * hang the request that is only listing models or providers.
 */
export const EXTENSION_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Run `fn` against a ModelRuntime that also includes providers registered by
 * extensions (an extension that calls `registerProvider` / `createProvider`
 * during resource loading). A bare `ModelRuntime.create()` only knows built-in
 * providers plus models.json, so extension-registered providers are invisible
 * without this.
 *
 * The agent dir acts as cwd so project-local extensions stay out; global package
 * extensions always load. Not cached: these routes need fresh credentials for
 * auth status and login/logout to be truthful.
 *
 * **Everything that builds one must go through here.** Creating those services
 * loads every configured extension, and the SDK has no way to unload them:
 * `AgentSessionServices`, `ResourceLoader` and `LoadExtensionsResult` expose no
 * dispose, and the only path that releases extensions is the `session_shutdown`
 * event, which only a *session's* extension runner can emit (the loader's
 * `runtime` is a stub until a runner initializes it). So this creates a
 * throwaway in-memory session and closes it when `fn` is done. Without that,
 * each read left the extension's own resources — a helper process, for an
 * extension such as AFT — alive for the life of the server process.
 */
export async function withExtensionServices<T>(
  options: CreateAgentSessionServicesOptions,
  fn: (services: AgentSessionServices) => Promise<T>,
): Promise<T> {
  const services = await createAgentSessionServices(options);
  const session = await createReleaseSession(services, options.cwd);
  try {
    return await fn(services);
  } finally {
    await releaseSession(session);
  }
}

/**
 * `withExtensionServices()` for the common case: the runtime alone, with the
 * agent dir as cwd.
 */
export function withExtensionRuntime<T>(fn: (runtime: ModelRuntime) => Promise<T>): Promise<T> {
  const agentDir = getAgentDir();
  return withExtensionServices(
    { cwd: agentDir, agentDir },
    ({ modelRuntime }) => fn(modelRuntime),
  );
}

/**
 * The session that exists only so `session_shutdown` can be emitted. In memory
 * (it must not put a file in the session list), no tools, no model work.
 *
 * A read must still work when this fails — it just cannot release what loading
 * the extensions started, which is worth a log rather than a failed request.
 */
async function createReleaseSession(
  services: AgentSessionServices,
  cwd: string,
): Promise<AgentSession | null> {
  try {
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    return session;
  } catch (error) {
    console.error("[pi-web] could not create a session to release extension resources:", error);
    return null;
  }
}

async function releaseSession(session: AgentSession | null): Promise<void> {
  if (!session) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(
            `[pi-web] extensions did not finish session_shutdown within ${EXTENSION_SHUTDOWN_TIMEOUT_MS}ms; disposing anyway`,
          );
          resolve();
        }, EXTENSION_SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.error("[pi-web] session_shutdown before dispose failed:", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    session.dispose();
  } catch (error) {
    console.error("[pi-web] disposing the extension-release session failed:", error);
  }
}
