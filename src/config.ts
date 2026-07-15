import { z } from "zod";

const databaseUrlSchema = z
  .string()
  .min(1, "DATABASE_URL is required")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "postgres:" || url.protocol === "postgresql:";
    } catch {
      return false;
    }
  }, "DATABASE_URL must be a valid PostgreSQL connection URL");

const configSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  ABLY_API_KEY: z.string().min(1, "ABLY_API_KEY is required"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppConfig = {
  databaseUrl: string;
  ablyApiKey: string;
  host: string;
  port: number;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = configSchema.parse(environment);

  return {
    databaseUrl: parsed.DATABASE_URL,
    ablyApiKey: parsed.ABLY_API_KEY,
    host: parsed.HOST,
    port: parsed.PORT,
  };
}
