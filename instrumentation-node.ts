import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startLiteMemoryMonitor } from "@/lib/lite-memory-monitor";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // The memory target is the server's, so the policy that acts on it is too:
  // one monitor per process, measuring on its own and reclaiming the oldest
  // idle session when the service is near or over its target. It only reads the
  // Lite configuration and the cgroup on a quiet tick.
  startLiteMemoryMonitor();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
