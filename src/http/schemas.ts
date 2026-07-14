import { z } from "zod/v4";

export const playerIdSchema = z.string().uuid();

export const playerIdHeadersSchema = z.object({
  "x-player-id": playerIdSchema,
});

export const matchParamsSchema = z.object({
  matchId: z.string().uuid(),
});

export const moveBodySchema = z.object({
  position: z.number().int().min(0).max(8),
});

export const queueEntrySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
});

export const matchParticipantSchema = z.object({
  playerId: z.string().uuid(),
  slot: z.union([z.literal(1), z.literal(2)]),
});

export const gameSchema = z.object({
  board: z.tuple([
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
    z.enum(["X", "O"]).nullable(),
  ]),
  nextPlayerId: z.string().uuid().nullable(),
  winnerPlayerId: z.string().uuid().nullable(),
  outcome: z.enum(["IN_PROGRESS", "WIN", "DRAW", "CANCELLED"]),
});

export const matchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["OPEN", "COMPLETED", "CANCELLED"]),
  participants: z.tuple([matchParticipantSchema, matchParticipantSchema]),
  createdAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  game: gameSchema,
});

export const idleStatusSchema = z.object({
  state: z.literal("IDLE"),
});

export const queuedStatusSchema = z.object({
  state: z.literal("QUEUED"),
  queueEntry: queueEntrySchema,
});

export const matchedStatusSchema = z.object({
  state: z.literal("MATCHED"),
  match: matchSchema,
});

export const matchmakingStatusSchema = z.discriminatedUnion("state", [
  idleStatusSchema,
  queuedStatusSchema,
  matchedStatusSchema,
]);

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
