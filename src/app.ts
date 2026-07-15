import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import staticFiles from "@fastify/static";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { loadConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { registerDevelopmentPlayerAuth } from "./http/auth.js";
import { registerErrorHandler } from "./http/errors.js";
import { registerMatchmakingRoutes } from "./http/routes/matchmaking.js";
import {
  AblyRealtimeGateway,
  type RealtimeGateway,
} from "./realtime/gateway.js";
import { MatchmakingService } from "./services/matchmaking-service.js";

export type CreateAppOptions = {
  databaseUrl?: string;
  realtime?: RealtimeGateway;
};

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const config =
    options.databaseUrl && options.realtime ? undefined : loadConfig();
  const databaseUrl = options.databaseUrl ?? config?.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const realtime =
    options.realtime ?? new AblyRealtimeGateway(config?.ablyApiKey ?? "");
  const connection = createDatabase(databaseUrl);
  const service = new MatchmakingService(connection.db);
  const app = Fastify({
    logger: true,
    genReqId: (request) => {
      const suppliedRequestId = request.headers["x-request-id"];
      return typeof suppliedRequestId === "string" &&
        suppliedRequestId.length > 0
        ? suppliedRequestId
        : randomUUID();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addHook("onClose", async () => {
    await connection.destroy();
  });

  registerErrorHandler(app);

  void app.register(swagger, {
    openapi: {
      info: { title: "Matchmaking Engine API", version: "1.0.0" },
    },
    transform: jsonSchemaTransform,
  });
  void app.register(swaggerUi, { routePrefix: "/documentation" });
  void app.register(
    async (v1) => {
      registerDevelopmentPlayerAuth(v1);
      registerMatchmakingRoutes(v1, service, realtime);
    },
    { prefix: "/v1" },
  );
  void app.register(staticFiles, {
    root: resolve(process.cwd(), "public"),
    prefix: "/",
  });

  return app;
}
