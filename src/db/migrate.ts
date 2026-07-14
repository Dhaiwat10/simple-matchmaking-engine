import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const defaultMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export async function runMigrations(
  databaseUrl: string,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const client = await pool.connect();

    try {
      const filenames = (await readdir(migrationsDirectory))
        .filter((filename) => filename.endsWith(".sql"))
        .sort();

      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const applied = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      );
      const appliedFilenames = new Set(applied.rows.map((row) => row.filename));

      for (const filename of filenames) {
        if (appliedFilenames.has(filename)) {
          continue;
        }

        await client.query(
          await readFile(resolve(migrationsDirectory, filename), "utf8"),
        );
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  await runMigrations(databaseUrl);
}
