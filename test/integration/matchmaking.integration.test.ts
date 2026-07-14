import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";

const playerA = "11111111-1111-4111-8111-111111111111";
const playerB = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";

let container: StartedPostgreSqlContainer;
let app: FastifyInstance;
let database: DatabaseConnection;

function playerHeaders(playerId: string): Record<string, string> {
  return { "x-player-id": playerId };
}

async function queuePlayer(playerId: string) {
  return app.inject({
    method: "POST",
    url: "/v1/queue",
    headers: playerHeaders(playerId),
  });
}

async function createOpenMatch(): Promise<string> {
  await queuePlayer(playerA);
  const response = await queuePlayer(playerB);
  expect(response.statusCode).toBe(201);
  return response.json().match.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16")
    .withDatabase("matchmaking")
    .withUsername("matchmaking")
    .withPassword("matchmaking")
    .start();
  const databaseUrl = container.getConnectionUri();
  await runMigrations(databaseUrl);
  database = createDatabase(databaseUrl);
  app = createApp({ databaseUrl });
  await app.ready();
});

beforeEach(async () => {
  await sql`TRUNCATE TABLE queue_entries, match_participants, players, matches RESTART IDENTITY CASCADE`.execute(
    database.db,
  );
});

afterAll(async () => {
  await app.close();
  await database.destroy();
  await container.stop();
});

describe("matchmaking integration contract", () => {
  it("queues, matches, and reports the shared open match", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/v1/matchmaking/status",
      headers: playerHeaders(playerA),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ state: "IDLE" });

    const firstJoin = await queuePlayer(playerA);
    expect(firstJoin.statusCode).toBe(202);
    expect(firstJoin.json().state).toBe("QUEUED");

    const secondJoin = await queuePlayer(playerB);
    expect(secondJoin.statusCode).toBe(201);
    const match = secondJoin.json().match;
    expect(match.status).toBe("OPEN");
    expect(match.participants).toEqual([
      { playerId: playerA, slot: 1 },
      { playerId: playerB, slot: 2 },
    ]);

    const firstStatus = await app.inject({
      method: "GET",
      url: "/v1/matchmaking/status",
      headers: playerHeaders(playerA),
    });
    expect(firstStatus.statusCode).toBe(200);
    expect(firstStatus.json()).toEqual({ state: "MATCHED", match });
  });

  it("rejects missing and malformed development player IDs", async () => {
    const missing = await app.inject({ method: "POST", url: "/v1/queue" });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/queue",
      headers: playerHeaders("not-a-uuid"),
    });

    for (const response of [missing, malformed]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_PLAYER_ID");
      expect(response.json().error.requestId).toBe(
        response.headers["x-request-id"],
      );
    }
  });

  it("preserves a repeated queue ticket and makes queue departure idempotent", async () => {
    const firstJoin = await queuePlayer(playerA);
    const repeatedJoin = await queuePlayer(playerA);
    expect(repeatedJoin.statusCode).toBe(200);
    expect(repeatedJoin.json().queueEntry.id).toBe(
      firstJoin.json().queueEntry.id,
    );

    const queuedCount = await database.db
      .selectFrom("queue_entries")
      .selectAll()
      .where("state", "=", "QUEUED")
      .execute();
    expect(queuedCount).toHaveLength(1);

    const firstLeave = await app.inject({
      method: "DELETE",
      url: "/v1/queue",
      headers: playerHeaders(playerA),
    });
    const secondLeave = await app.inject({
      method: "DELETE",
      url: "/v1/queue",
      headers: playerHeaders(playerA),
    });
    expect(firstLeave.statusCode).toBe(204);
    expect(secondLeave.statusCode).toBe(204);
  });

  it("enforces match ownership and terminal transitions", async () => {
    const matchId = await createOpenMatch();

    for (const request of [
      { method: "GET", url: `/v1/matches/${matchId}` },
      { method: "POST", url: `/v1/matches/${matchId}/complete` },
      { method: "POST", url: `/v1/matches/${matchId}/cancel` },
    ] as const) {
      const response = await app.inject({
        ...request,
        headers: playerHeaders(outsider),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("MATCH_FORBIDDEN");
    }

    const completed = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/complete`,
      headers: playerHeaders(playerA),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("COMPLETED");

    const repeated = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/cancel`,
      headers: playerHeaders(playerB),
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe("MATCH_ALREADY_TERMINAL");

    for (const playerId of [playerA, playerB]) {
      const status = await app.inject({
        method: "GET",
        url: "/v1/matchmaking/status",
        headers: playerHeaders(playerId),
      });
      expect(status.json()).toEqual({ state: "IDLE" });
    }

    expect((await queuePlayer(playerA)).statusCode).toBe(202);
  });

  it("allows either participant to cancel an open match", async () => {
    const matchId = await createOpenMatch();
    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/cancel`,
      headers: playerHeaders(playerB),
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("CANCELLED");
  });

  it("serializes twenty concurrent joins without duplicate assignment", async () => {
    const playerIds = Array.from({ length: 20 }, () => randomUUID());
    const joins = await Promise.all(
      playerIds.map((playerId) => queuePlayer(playerId)),
    );
    expect(joins.map((response) => response.statusCode).sort()).toEqual(
      Array.from({ length: 10 }, () => 201).concat(
        Array.from({ length: 10 }, () => 202),
      ),
    );

    const openMatches = await database.db
      .selectFrom("matches")
      .selectAll()
      .where("status", "=", "OPEN")
      .execute();
    const participants = await database.db
      .selectFrom("match_participants")
      .selectAll()
      .execute();
    const queuedEntries = await database.db
      .selectFrom("queue_entries")
      .selectAll()
      .where("state", "=", "QUEUED")
      .execute();

    expect(openMatches).toHaveLength(10);
    expect(participants).toHaveLength(20);
    expect(
      new Set(participants.map((participant) => participant.player_id)).size,
    ).toBe(20);
    expect(queuedEntries).toHaveLength(0);

    const statuses = await Promise.all(
      playerIds.map((playerId) =>
        app.inject({
          method: "GET",
          url: "/v1/matchmaking/status",
          headers: playerHeaders(playerId),
        }),
      ),
    );
    expect(
      statuses.every((response) => response.json().state === "MATCHED"),
    ).toBe(true);
  });
});
