# Matchmaking Engine API

A small Fastify, PostgreSQL, Kysely, React, and TypeScript project. Players enter a global FIFO queue, the engine atomically forms 1v1 matches, and the browser provides an authoritative tic-tac-toe game backed by persisted PostgreSQL match and move state.

## Local startup

Requirements: Node 22+, pnpm, Docker Desktop with a running daemon, and an [Ably](https://ably.com/) API key.

```bash
pnpm install
cp .env.example .env.local
# Set ABLY_API_KEY in .env.local to an Ably server API key.
docker compose up -d postgres
DATABASE_URL=postgresql://matchmaking:matchmaking@localhost:5432/matchmaking pnpm db:migrate
pnpm build
node --env-file=.env.local dist/server.js
```

In a second terminal, queue two players and poll the first player:

```bash
curl -i -X POST http://localhost:3000/v1/queue \
  -H 'X-Player-Id: 11111111-1111-4111-8111-111111111111'
# 202 Accepted: {"state":"QUEUED",...}

curl -i -X POST http://localhost:3000/v1/queue \
  -H 'X-Player-Id: 22222222-2222-4222-8222-222222222222'
# 201 Created: {"state":"MATCHED","match":{...}}

curl -i http://localhost:3000/v1/matchmaking/status \
  -H 'X-Player-Id: 11111111-1111-4111-8111-111111111111'
# 200 OK: {"state":"MATCHED","match":{"status":"OPEN",...}}

curl -i http://localhost:3000/documentation/json
# 200 OK: OpenAPI JSON
```

Interactive API reference: [http://localhost:3000/documentation](http://localhost:3000/documentation).

## API contract

Every `/v1` endpoint requires `X-Player-Id: <UUID>`. This is a **development-only identity boundary**, not authentication. Production must replace it with verified authentication that supplies the canonical player ID; it must not trust both a token and a caller-controlled header.

Every response includes `X-Request-Id`. Errors never expose PostgreSQL details and use this envelope:

```json
{
  "error": {
    "code": "MATCH_IN_PROGRESS",
    "message": "Player already has an open match",
    "requestId": "..."
  }
}
```

| Method   | Endpoint                        | Success             | Purpose                                                           |
| -------- | ------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `POST`   | `/v1/queue`                     | `200`, `201`, `202` | Reuse an existing ticket, form a match, or queue the player.      |
| `GET`    | `/v1/matchmaking/status`        | `200`               | Read initial `IDLE`, `QUEUED`, or `MATCHED` state.                |
| `GET`    | `/v1/matchmaking/metrics`       | `200`               | Read initial queued-player and active-match counts.               |
| `GET`    | `/v1/realtime/token`            | `200`               | Issue a 15-minute, player-scoped Ably subscription token.         |
| `DELETE` | `/v1/queue`                     | `204`               | Idempotently cancel only a queued ticket.                         |
| `GET`    | `/v1/matches/:matchId`          | `200`               | Fetch a participant-owned open or terminal match.                 |
| `POST`   | `/v1/matches/:matchId/moves`    | `200`               | Submit one legal position from `0` through `8` for the next turn. |
| `POST`   | `/v1/matches/:matchId/complete` | `200`               | Complete an `OPEN` match as either participant.                   |
| `POST`   | `/v1/matches/:matchId/cancel`   | `200`               | Cancel an `OPEN` match as either participant.                     |

Relevant failure codes: `INVALID_PLAYER_ID` (`400`), `MATCH_FORBIDDEN` (`403`), `MATCH_NOT_FOUND` (`404`), `MATCH_IN_PROGRESS` and `MATCH_ALREADY_TERMINAL` (`409`), plus `INTERNAL_ERROR` (`500`).

## Concurrency and data integrity

`MatchmakingService.joinQueue` holds one PostgreSQL transaction-scoped advisory lock for its queue decision:

```sql
SELECT pg_advisory_xact_lock(481516, 1)
```

That fixed lock deliberately serializes the initial global pool. A request either creates one `QUEUED` entry or atomically creates one `OPEN` match from exactly two players. The lock is released at transaction completion; it is never held during a match.

The migration is the durable state-machine boundary:

- PostgreSQL enums constrain queue entries to `QUEUED`, `MATCHED`, or `CANCELLED`, and matches to `OPEN`, `COMPLETED`, or `CANCELLED`.
- Queue-state checks require the correct `match_id` and `resolved_at` shape for every state.
- A partial unique index permits at most one `QUEUED` entry per player.
- `(state, created_at, id)` supports FIFO candidate selection.
- Participant foreign keys, a two-slot check, and a unique `(match_id, slot)` constrain matches to slots 1 and 2.
- `players.active_match_id` is set and cleared in the same transactions as match transitions, enforcing the service-level one-active-match invariant.

When rank, region, or latency becomes a requirement, derive an advisory-lock key from a persisted immutable pool key and add the corresponding columns and indexes in a new migration. Do not weaken the transaction or introduce Redis before that requirement exists.

## Tests

Docker is required because both suites use disposable PostgreSQL 16 containers through Testcontainers.

```bash
pnpm test
pnpm test:e2e
```

- `test/integration/` runs the real application through `app.inject()` against PostgreSQL. It verifies status and lifecycle contracts, queue idempotency, ownership, terminal transitions, and a white-box 20-player concurrent-join proof.
- `test/e2e/` binds a real ephemeral TCP listener and uses native `fetch` only. It verifies HTTP lifecycle/error behavior, 20-player concurrency, and the published OpenAPI surface without inspecting repositories or the database.

## Browser game and realtime delivery

The React/Vite browser app creates a UUID in `localStorage`, joins the same queue, and renders an authoritative 1v1 tic-tac-toe game. Match state, every legal move, winner, draw, and terminal match remain in PostgreSQL.

Initial status and metrics use HTTP. After that, the browser maintains an authenticated Ably Realtime connection rather than polling. Fastify signs a 15-minute token bound to the caller's UUID and grants only `subscribe` access to that player's `player:<UUID>` channel and the read-only `matchmaking:metrics` channel. The browser never receives the Ably API key.

After each successful database commit, the API publishes the canonical `MatchView` to both participants and current queue/match metrics to the shared metrics channel. Publication failure is logged and does not roll back an already committed game mutation; a browser can reconnect and refetch its authoritative status. The UI exposes the Ably connection state so a player can distinguish a live delivery path from reconnecting or failed delivery.

This remains a development identity boundary: because `X-Player-Id` is caller-controlled, a caller can request a token for any UUID. Production must replace the header with verified server-side identity before relying on the channel capability as authorization.

### Vercel deployment

Vercel serves the Vite build from `public/` and runs Fastify as the `api/[...path].ts` serverless function. `vercel.json` rewrites `/v1/*` and `/documentation/*` to that function, so the browser and API share one origin; there is no persistent Fastify process or second deployment to manage.

1. Create a Neon PostgreSQL database and apply migrations using its direct connection URL:

   ```bash
   DATABASE_URL='postgresql://…' pnpm db:migrate
   ```

2. In Vercel, set the **pooled** Neon connection string as `DATABASE_URL` and a server-only Ably API key as `ABLY_API_KEY` for Production and Preview. Never use a `VITE_` prefix or put the key in browser code.
3. Disable Production Deployment Protection before sharing the game; otherwise visitors receive Vercel authentication pages instead of API JSON.
4. Deploy the repository, then verify the production API:

   ```bash
   curl -i https://YOUR-DOMAIN/v1/matchmaking/status \
     -H 'X-Player-Id: 11111111-1111-4111-8111-111111111111'
   ```

   Expected: `HTTP 200` with `{"state":"IDLE"}` or a queued/matched status.

The `X-Player-Id` header remains development-only identity. Do not expose this deployment as a production authenticated game without replacing it with verified server-side identity.

## Intentional future extensions

Ranking, regions, latency, teams, persistent presence, production authentication, and durable game-room semantics are intentionally not implemented. A future game integration should use verified identity and a server-authoritative game process; it can keep the player-channel publication boundary or migrate it to durable room/pub-sub infrastructure.
