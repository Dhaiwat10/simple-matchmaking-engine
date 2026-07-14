import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";

import { createApp } from "../../src/app.js";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";

export type E2eServer = {
  baseUrl: string;
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

export async function startE2eServer(): Promise<E2eServer> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16",
  )
    .withDatabase("matchmaking")
    .withUsername("matchmaking")
    .withPassword("matchmaking")
    .start();
  const databaseUrl = container.getConnectionUri();
  await runMigrations(databaseUrl);

  const database: DatabaseConnection = createDatabase(databaseUrl);
  const app: FastifyInstance = createApp({ databaseUrl });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    reset: async () => {
      await sql`TRUNCATE TABLE queue_entries, match_participants, players, matches RESTART IDENTITY CASCADE`.execute(
        database.db,
      );
    },
    close: async () => {
      await app.close();
      await database.destroy();
      await container.stop();
    },
  };
}
