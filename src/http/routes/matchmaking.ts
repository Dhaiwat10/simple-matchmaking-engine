import { z } from "zod/v4";

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { MatchView } from "../../domain/matchmaking.js";
import { MatchmakingService } from "../../services/matchmaking-service.js";
import type { RealtimeGateway } from "../../realtime/gateway.js";
import {
  errorResponseSchema,
  matchParamsSchema,
  matchSchema,
  matchmakingStatusSchema,
  moveBodySchema,
  matchedStatusSchema,
  playerIdHeadersSchema,
  queueMetricsSchema,
  realtimeTokenSchema,
  queuedStatusSchema,
} from "../schemas.js";

export function registerMatchmakingRoutes(
  app: FastifyInstance,
  service: MatchmakingService,
  realtime: RealtimeGateway,
): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const publishRealtime = async (
    match: MatchView | undefined,
    includeMetrics: boolean,
  ): Promise<void> => {
    const publications: Promise<void>[] = [];
    if (match) publications.push(realtime.publishMatch(match));
    if (includeMetrics) {
      publications.push(
        service
          .getQueueMetrics()
          .then((metrics) => realtime.publishMetrics(metrics)),
      );
    }

    try {
      await Promise.all(publications);
    } catch (error) {
      routes.log.error(error, "Realtime publication failed after commit");
    }
  };

  routes.route({
    method: "POST",
    url: "/queue",
    schema: {
      headers: playerIdHeadersSchema,
      response: {
        200: queuedStatusSchema,
        201: matchedStatusSchema,
        202: queuedStatusSchema,
        400: errorResponseSchema,
        409: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await service.joinQueue(request.playerId);

      await publishRealtime(
        result.outcome === "MATCHED" ? result.status.match : undefined,
        result.outcome !== "ALREADY_QUEUED",
      );

      if (result.outcome === "MATCHED") {
        return reply.code(201).send(result.status);
      }

      if (result.outcome === "ALREADY_QUEUED") {
        return reply.code(200).send(result.status);
      }

      return reply.code(202).send(result.status);
    },
  });

  routes.route({
    method: "GET",
    url: "/matchmaking/status",
    schema: {
      headers: playerIdHeadersSchema,
      response: {
        200: matchmakingStatusSchema,
        400: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (request) => service.getStatus(request.playerId),
  });

  routes.route({
    method: "GET",
    url: "/matchmaking/metrics",
    schema: {
      headers: playerIdHeadersSchema,
      response: {
        200: queueMetricsSchema,
        400: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async () => service.getQueueMetrics(),
  });

  routes.route({
    method: "GET",
    url: "/realtime/token",
    schema: {
      headers: playerIdHeadersSchema,
      response: {
        200: realtimeTokenSchema,
        400: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (request) => realtime.createTokenRequest(request.playerId),
  });
  routes.route({
    method: "DELETE",
    url: "/queue",
    schema: {
      headers: playerIdHeadersSchema,
      response: {
        204: z.void(),
        400: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      await service.leaveQueue(request.playerId);
      await publishRealtime(undefined, true);
      return reply.code(204).send();
    },
  });

  routes.route({
    method: "GET",
    url: "/matches/:matchId",
    schema: {
      headers: playerIdHeadersSchema,
      params: matchParamsSchema,
      response: {
        200: matchSchema,
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (request): Promise<MatchView> =>
      service.getMatch(request.playerId, request.params.matchId),
  });

  routes.route({
    method: "POST",
    url: "/matches/:matchId/moves",
    schema: {
      headers: playerIdHeadersSchema,
      params: matchParamsSchema,
      body: moveBodySchema,
      response: {
        200: matchSchema,
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (request): Promise<MatchView> => {
      const match = await service.makeMove(
        request.playerId,
        request.params.matchId,
        request.body.position,
      );
      await publishRealtime(match, false);
      return match;
    },
  });

  for (const [path, status] of [
    ["/matches/:matchId/complete", "COMPLETED"],
    ["/matches/:matchId/cancel", "CANCELLED"],
  ] as const) {
    routes.route({
      method: "POST",
      url: path,
      schema: {
        headers: playerIdHeadersSchema,
        params: matchParamsSchema,
        response: {
          200: matchSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      handler: async (request): Promise<MatchView> => {
        const match = await service.endMatch(
          request.playerId,
          request.params.matchId,
          status,
        );
        await publishRealtime(match, true);
        return match;
      },
    });
  }
}
