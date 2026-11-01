import { ConfigError, loadConfig } from "@ncb/shared";
import { WriterLockError } from "@ncb/db";
import { createServer } from "./server.js";

/** Process entry (dist/index.js). Boots both listeners, then the database, and stops cleanly on SIGTERM. */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(78);
    }
    throw e;
  }

  const server = await createServer({ config });
  const { apiPort, archivePort } = await server.listen();
  server.app.log.info({ apiPort, archivePort }, "listening");

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      server.app.log.warn({ signal }, "second signal, exiting now");
      process.exit(1);
    }
    stopping = true;
    server.app.log.info({ signal }, "shutting down");
    const hard = setTimeout(() => {
      server.app.log.error("shutdown took too long, exiting");
      process.exit(1);
    }, (config.NCB_SHUTDOWN_GRACE_SECONDS + 5) * 1000);
    hard.unref();
    server.close().then(
      () => process.exit(0),
      (e) => {
        server.app.log.error({ err: String(e) }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  try {
    await server.initialize();
  } catch (e) {
    if (e instanceof WriterLockError) server.app.log.fatal(e.message);
    else server.app.log.fatal({ err: e instanceof Error ? e.message : String(e) }, "startup failed");
    await server.close().catch(() => undefined);
    process.exit(1);
  }
}

void main();
