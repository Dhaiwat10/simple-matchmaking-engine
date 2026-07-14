import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

import { DomainError } from "../domain/errors.js";

export class HttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const requestId = request.id;

    if (error instanceof DomainError) {
      const statusCodeByCode = {
        MATCH_IN_PROGRESS: 409,
        MATCH_NOT_FOUND: 404,
        MATCH_FORBIDDEN: 403,
        MATCH_ALREADY_TERMINAL: 409,
        NOT_YOUR_TURN: 409,
        INVALID_MOVE: 409,
      } as const;

      return reply.code(statusCodeByCode[error.code]).send({
        error: { code: error.code, message: error.message, requestId },
      });
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId },
      });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
          requestId,
        },
      });
    }

    request.log.error({ err: error, requestId }, "Unhandled request error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId,
      },
    });
  });
}
