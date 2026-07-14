import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { startE2eServer, type E2eServer } from "./support.js";

const playerA = "11111111-1111-4111-8111-111111111111";
const playerB = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
const missingMatchId = "99999999-9999-4999-8999-999999999999";

const matchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["OPEN", "COMPLETED", "CANCELLED"]),
  participants: z.tuple([
    z.object({ playerId: z.string().uuid(), slot: z.literal(1) }),
    z.object({ playerId: z.string().uuid(), slot: z.literal(2) }),
  ]),
  createdAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
});

const statusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("IDLE") }),
  z.object({
    state: z.literal("QUEUED"),
    queueEntry: z.object({
      id: z.string().uuid(),
      createdAt: z.string().datetime({ offset: true }),
    }),
  }),
  z.object({ state: z.literal("MATCHED"), match: matchSchema }),
]);

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

let server: E2eServer;

function playerHeaders(playerId: string): HeadersInit {
  return { "X-Player-Id": playerId };
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${server.baseUrl}${path}`, init);
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

async function queuePlayer(playerId: string) {
  return request("/v1/queue", {
    method: "POST",
    headers: playerHeaders(playerId),
  });
}

async function createOpenMatch(): Promise<z.infer<typeof matchSchema>> {
  await queuePlayer(playerA);
  const joined = await queuePlayer(playerB);
  expect(joined.response.status).toBe(201);
  const joinedStatus = statusSchema.parse(joined.body);
  expect(joinedStatus.state).toBe("MATCHED");

  if (joinedStatus.state !== "MATCHED") {
    throw new Error("Second queued player did not receive a match");
  }

  return joinedStatus.match;
}

function expectError(
  result: { response: Response; body: unknown },
  expectedStatus: number,
  expectedCode: string,
): void {
  expect(result.response.status).toBe(expectedStatus);
  expect(result.response.headers.get("x-request-id")).toBeTruthy();
  const payload = errorSchema.parse(result.body);
  expect(payload.error.code).toBe(expectedCode);
  expect(payload.error.requestId).toBe(
    result.response.headers.get("x-request-id"),
  );
}

beforeAll(async () => {
  server = await startE2eServer();
});

beforeEach(async () => {
  await server.reset();
});

afterAll(async () => {
  await server.close();
});

describe("matchmaking HTTP API", () => {
  it("moves two players from queue to completion and permits a new queue entry", async () => {
    const initial = await request("/v1/matchmaking/status", {
      headers: playerHeaders(playerA),
    });
    expect(initial.response.status).toBe(200);
    expect(statusSchema.parse(initial.body)).toEqual({ state: "IDLE" });

    const firstJoin = await queuePlayer(playerA);
    expect(firstJoin.response.status).toBe(202);
    expect(statusSchema.parse(firstJoin.body).state).toBe("QUEUED");

    const secondJoin = await queuePlayer(playerB);
    expect(secondJoin.response.status).toBe(201);
    const secondStatus = statusSchema.parse(secondJoin.body);
    expect(secondStatus.state).toBe("MATCHED");
    if (secondStatus.state !== "MATCHED") {
      throw new Error("Second player was not matched");
    }

    const [firstPoll, secondPoll] = await Promise.all([
      request("/v1/matchmaking/status", { headers: playerHeaders(playerA) }),
      request("/v1/matchmaking/status", { headers: playerHeaders(playerB) }),
    ]);
    const firstMatchStatus = statusSchema.parse(firstPoll.body);
    const secondMatchStatus = statusSchema.parse(secondPoll.body);
    expect(firstMatchStatus.state).toBe("MATCHED");
    expect(secondMatchStatus.state).toBe("MATCHED");
    if (
      firstMatchStatus.state !== "MATCHED" ||
      secondMatchStatus.state !== "MATCHED"
    ) {
      throw new Error("Polled status did not expose both players’ match");
    }
    expect(firstMatchStatus.match).toEqual(secondMatchStatus.match);
    expect(firstMatchStatus.match.participants).toEqual([
      { playerId: playerA, slot: 1 },
      { playerId: playerB, slot: 2 },
    ]);

    for (const playerId of [playerA, playerB]) {
      const fetchedMatch = await request(
        `/v1/matches/${secondStatus.match.id}`,
        {
          headers: playerHeaders(playerId),
        },
      );
      expect(fetchedMatch.response.status).toBe(200);
      expect(matchSchema.parse(fetchedMatch.body)).toEqual(secondStatus.match);
    }

    const completed = await request(
      `/v1/matches/${secondStatus.match.id}/complete`,
      {
        method: "POST",
        headers: playerHeaders(playerA),
      },
    );
    expect(completed.response.status).toBe(200);
    expect(matchSchema.parse(completed.body).status).toBe("COMPLETED");

    for (const playerId of [playerA, playerB]) {
      const status = await request("/v1/matchmaking/status", {
        headers: playerHeaders(playerId),
      });
      expect(statusSchema.parse(status.body)).toEqual({ state: "IDLE" });
    }
    expect((await queuePlayer(playerA)).response.status).toBe(202);
  });

  it("handles cancellation and publishes the documented failure envelope", async () => {
    await queuePlayer(playerA);
    for (let index = 0; index < 2; index += 1) {
      const leave = await request("/v1/queue", {
        method: "DELETE",
        headers: playerHeaders(playerA),
      });
      expect(leave.response.status).toBe(204);
    }
    const afterLeave = await request("/v1/matchmaking/status", {
      headers: playerHeaders(playerA),
    });
    expect(statusSchema.parse(afterLeave.body)).toEqual({ state: "IDLE" });

    const openMatch = await createOpenMatch();
    const cancelled = await request(`/v1/matches/${openMatch.id}/cancel`, {
      method: "POST",
      headers: playerHeaders(playerB),
    });
    expect(cancelled.response.status).toBe(200);
    expect(matchSchema.parse(cancelled.body).status).toBe("CANCELLED");

    expectError(
      await request("/v1/queue", { method: "POST" }),
      400,
      "INVALID_PLAYER_ID",
    );
    expectError(
      await request("/v1/queue", {
        method: "POST",
        headers: playerHeaders("invalid"),
      }),
      400,
      "INVALID_PLAYER_ID",
    );

    for (const endpoint of [
      { method: "GET", path: `/v1/matches/${openMatch.id}` },
      { method: "POST", path: `/v1/matches/${openMatch.id}/complete` },
      { method: "POST", path: `/v1/matches/${openMatch.id}/cancel` },
    ]) {
      expectError(
        await request(endpoint.path, {
          method: endpoint.method,
          headers: playerHeaders(outsider),
        }),
        403,
        "MATCH_FORBIDDEN",
      );
    }

    expectError(
      await request(`/v1/matches/${missingMatchId}`, {
        headers: playerHeaders(outsider),
      }),
      404,
      "MATCH_NOT_FOUND",
    );
    expectError(
      await request(`/v1/matches/${openMatch.id}/complete`, {
        method: "POST",
        headers: playerHeaders(playerA),
      }),
      409,
      "MATCH_ALREADY_TERMINAL",
    );
  });

  it("forms ten distinct matches under concurrent HTTP joins", async () => {
    const playerIds = Array.from({ length: 20 }, () => randomUUID());
    const joins = await Promise.all(
      playerIds.map((playerId) => queuePlayer(playerId)),
    );
    const statuses = joins
      .map((joined) => joined.response.status)
      .sort((left, right) => left - right);
    expect(statuses).toEqual([
      201, 201, 201, 201, 201, 201, 201, 201, 201, 201, 202, 202, 202, 202, 202,
      202, 202, 202, 202, 202,
    ]);

    const polls = await Promise.all(
      playerIds.map((playerId) =>
        request("/v1/matchmaking/status", { headers: playerHeaders(playerId) }),
      ),
    );
    const matches = polls.map((poll) => {
      const status = statusSchema.parse(poll.body);
      if (status.state !== "MATCHED") {
        throw new Error(
          `Expected ${status.state} status after concurrent matchmaking`,
        );
      }
      return status.match;
    });
    const distinctMatchIds = [...new Set(matches.map((match) => match.id))];
    expect(distinctMatchIds).toHaveLength(10);

    for (const matchId of distinctMatchIds) {
      const knownParticipant = matches.find((match) => match.id === matchId)
        ?.participants[0].playerId;
      if (!knownParticipant) {
        throw new Error(`No participant was discovered for match ${matchId}`);
      }
      const fetched = await request(`/v1/matches/${matchId}`, {
        headers: playerHeaders(knownParticipant),
      });
      expect(fetched.response.status).toBe(200);
      const match = matchSchema.parse(fetched.body);
      expect(
        new Set(match.participants.map((participant) => participant.playerId))
          .size,
      ).toBe(2);
      expect(match.participants.map((participant) => participant.slot)).toEqual(
        [1, 2],
      );
    }

    const repeatJoins = await Promise.all(
      playerIds.map((playerId) => queuePlayer(playerId)),
    );
    for (const repeatJoin of repeatJoins) {
      expectError(repeatJoin, 409, "MATCH_IN_PROGRESS");
    }
  });

  it("publishes the protected OpenAPI contract and interactive reference", async () => {
    const openApiResponse = await request("/documentation/json");
    expect(openApiResponse.response.status).toBe(200);
    const documentSchema = z.object({
      paths: z.record(z.string(), z.unknown()),
    });
    const document = documentSchema.parse(openApiResponse.body);
    const protectedPaths = [
      "/v1/queue",
      "/v1/matchmaking/status",
      "/v1/matches/{matchId}",
      "/v1/matches/{matchId}/complete",
      "/v1/matches/{matchId}/cancel",
    ];

    for (const path of protectedPaths) {
      expect(document.paths).toHaveProperty(path);
      const operations = z
        .record(z.string(), z.unknown())
        .parse(document.paths[path]);
      for (const operation of Object.values(operations)) {
        const operationSchema = z.object({
          parameters: z.array(
            z.object({
              in: z.string(),
              name: z.string(),
              required: z.boolean().optional(),
            }),
          ),
        });
        expect(
          operationSchema
            .parse(operation)
            .parameters.some(
              (parameter) =>
                parameter.in === "header" &&
                parameter.name === "x-player-id" &&
                parameter.required === true,
            ),
        ).toBe(true);
      }
    }

    const reference = await fetch(`${server.baseUrl}/documentation`);
    expect(reference.status).toBe(200);
  });
});
