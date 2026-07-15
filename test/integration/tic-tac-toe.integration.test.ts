import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TestRealtimeGateway } from "../support/realtime.js";

const x = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const o = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let container: StartedPostgreSqlContainer;
let app: FastifyInstance;
let realtime: TestRealtimeGateway;

const headers = (id: string) => ({ "x-player-id": id });

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  await runMigrations(container.getConnectionUri());
  realtime = new TestRealtimeGateway();
  app = createApp({ databaseUrl: container.getConnectionUri(), realtime });
  await app.ready();
});

beforeEach(async () => {
  await app.inject({ method: "DELETE", url: "/v1/queue", headers: headers(x) });
  await app.inject({ method: "DELETE", url: "/v1/queue", headers: headers(o) });
});

afterAll(async () => {
  await app.close();
  await container.stop();
});

it("records an authoritative winning tic-tac-toe game", async () => {
  await app.inject({ method: "POST", url: "/v1/queue", headers: headers(x) });
  const joined = await app.inject({
    method: "POST",
    url: "/v1/queue",
    headers: headers(o),
  });
  const matchId = joined.json().match.id as string;

  for (const [playerId, position] of [
    [x, 0],
    [o, 3],
    [x, 1],
    [o, 4],
    [x, 2],
  ] as const) {
    const moved = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/moves`,
      headers: headers(playerId),
      payload: { position },
    });
    expect(moved.statusCode).toBe(200);
  }

  const match = await app.inject({
    method: "GET",
    url: `/v1/matches/${matchId}`,
    headers: headers(x),
  });
  expect(match.json().game).toMatchObject({
    outcome: "WIN",
    winnerPlayerId: x,
    board: ["X", "X", "X", "O", "O", null, null, null, null],
  });
  expect(match.json().status).toBe("COMPLETED");
});
