import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { Database } from "./types.js";

export type DatabaseConnection = {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
};

export function createDatabase(databaseUrl: string): DatabaseConnection {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    db,
    destroy: async () => {
      await db.destroy();
    },
  };
}
