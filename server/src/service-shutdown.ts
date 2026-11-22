import { MessageChannel } from "node:worker_threads";
import { redactTrace } from "./utils.js";

/** A host Stop signal starts a drain, not a deadline for releasing native ownership. */
export function installServiceShutdown(drain: (signal: NodeJS.Signals) => Promise<void>): void {
  let draining = false;
  let keepAlive: MessageChannel | undefined;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (draining) return;
    draining = true;
    // Once HTTP is closed the DB Worker is unref'd at idle. A pending Promise
    // alone cannot keep the writer process (and its descriptor) alive.
    keepAlive ??= new MessageChannel();
    keepAlive.port1.ref();
    try { await drain(signal); }
    catch (error) {
      draining = false;
      console.error("Service shutdown unconfirmed; process retained. Inspect cleanup before retrying shutdown:",
        redactTrace(error instanceof Error ? error.message : String(error)));
      return;
    }
    keepAlive.port1.close(); keepAlive.port2.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}
