import type { FastifyInstance } from "fastify";

import { HttpError } from "./errors.js";
import { playerIdSchema } from "./schemas.js";

declare module "fastify" {
  interface FastifyRequest {
    playerId: string;
  }
}

export function registerDevelopmentPlayerAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);

    const parsed = playerIdSchema.safeParse(request.headers["x-player-id"]);

    if (!parsed.success) {
      throw new HttpError(
        400,
        "INVALID_PLAYER_ID",
        "X-Player-Id must be a valid UUID",
      );
    }

    request.playerId = parsed.data;
  });
}
