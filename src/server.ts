import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp({ databaseUrl: config.databaseUrl });
let closing = false;

const shutdown = async (signal: string): Promise<void> => {
  if (closing) {
    return;
  }

  closing = true;
  app.log.info({ signal }, "Shutting down server");
  await app.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, "Unable to start server");
  await app.close();
  process.exitCode = 1;
}
