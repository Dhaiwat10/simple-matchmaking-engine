import { Kysely, sql, Transaction, type Selectable } from "kysely";

import type {
  Database,
  MatchParticipantsTable,
  MatchesTable,
  PlayersTable,
  QueueEntriesTable,
} from "../db/types.js";
import type { MatchStatus } from "../domain/matchmaking.js";

export type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
export type PlayerRow = Selectable<PlayersTable>;
export type QueueEntryRow = Selectable<QueueEntriesTable>;
export type MatchRow = Selectable<MatchesTable>;
export type MatchParticipantRow = Selectable<MatchParticipantsTable>;

export type MatchWithParticipants = {
  match: MatchRow;
  participants: MatchParticipantRow[];
};

export type QueuedCandidate = QueueEntryRow & {
  active_match_id: string | null;
};

export class MatchmakingRepository {
  public constructor(private readonly executor: DatabaseExecutor) {}

  public async acquireAdvisoryLock(
    key: readonly [number, number],
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(${key[0]}, ${key[1]})`.execute(
      this.executor,
    );
  }

  public async createOrFetchPlayer(playerId: string): Promise<PlayerRow> {
    await this.executor
      .insertInto("players")
      .values({ id: playerId })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();

    const player = await this.executor
      .selectFrom("players")
      .selectAll()
      .where("id", "=", playerId)
      .executeTakeFirstOrThrow();

    return player;
  }

  public async findPlayer(playerId: string): Promise<PlayerRow | undefined> {
    return this.executor
      .selectFrom("players")
      .selectAll()
      .where("id", "=", playerId)
      .executeTakeFirst();
  }

  public async findQueuedEntry(
    playerId: string,
  ): Promise<QueueEntryRow | undefined> {
    return this.executor
      .selectFrom("queue_entries")
      .selectAll()
      .where("player_id", "=", playerId)
      .where("state", "=", "QUEUED")
      .executeTakeFirst();
  }

  public async findOldestQueuedCandidateExcluding(
    playerId: string,
  ): Promise<QueuedCandidate | undefined> {
    return this.executor
      .selectFrom("queue_entries")
      .innerJoin("players", "players.id", "queue_entries.player_id")
      .selectAll("queue_entries")
      .select("players.active_match_id")
      .where("queue_entries.state", "=", "QUEUED")
      .where("queue_entries.player_id", "!=", playerId)
      .orderBy("queue_entries.created_at", "asc")
      .orderBy("queue_entries.id", "asc")
      .executeTakeFirst();
  }

  public async createQueuedEntry(playerId: string): Promise<QueueEntryRow> {
    return this.executor
      .insertInto("queue_entries")
      .values({ player_id: playerId, state: "QUEUED" })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  public async createMatchedEntry(
    playerId: string,
    matchId: string,
  ): Promise<QueueEntryRow> {
    return this.executor
      .insertInto("queue_entries")
      .values({
        player_id: playerId,
        state: "MATCHED",
        match_id: matchId,
        resolved_at: sql<Date>`now()`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  public async markEntryMatched(
    entryId: string,
    matchId: string,
  ): Promise<void> {
    await this.executor
      .updateTable("queue_entries")
      .set({
        state: "MATCHED",
        match_id: matchId,
        resolved_at: sql<Date>`now()`,
      })
      .where("id", "=", entryId)
      .where("state", "=", "QUEUED")
      .executeTakeFirstOrThrow();
  }

  public async cancelQueuedEntry(playerId: string): Promise<void> {
    await this.executor
      .updateTable("queue_entries")
      .set({
        state: "CANCELLED",
        resolved_at: sql<Date>`now()`,
      })
      .where("player_id", "=", playerId)
      .where("state", "=", "QUEUED")
      .execute();
  }

  public async createOpenMatch(
    candidatePlayerId: string,
    newcomerPlayerId: string,
  ): Promise<MatchRow> {
    const match = await this.executor
      .insertInto("matches")
      .values({ status: "OPEN", next_player_id: candidatePlayerId })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.executor
      .insertInto("match_participants")
      .values([
        { match_id: match.id, player_id: candidatePlayerId, slot: 1 },
        { match_id: match.id, player_id: newcomerPlayerId, slot: 2 },
      ])
      .execute();

    return match;
  }

  public async setActiveMatch(
    playerIds: readonly [string, string],
    matchId: string,
  ): Promise<void> {
    await this.executor
      .updateTable("players")
      .set({ active_match_id: matchId })
      .where("id", "in", playerIds)
      .execute();
  }

  public async findParticipant(
    matchId: string,
    playerId: string,
  ): Promise<boolean> {
    const participant = await this.executor
      .selectFrom("match_participants")
      .select("player_id")
      .where("match_id", "=", matchId)
      .where("player_id", "=", playerId)
      .executeTakeFirst();

    return participant !== undefined;
  }

  public async findMatch(matchId: string): Promise<MatchRow | undefined> {
    return this.executor
      .selectFrom("matches")
      .selectAll()
      .where("id", "=", matchId)
      .executeTakeFirst();
  }

  public async findMatchForUpdate(
    matchId: string,
  ): Promise<MatchRow | undefined> {
    return this.executor
      .selectFrom("matches")
      .selectAll()
      .where("id", "=", matchId)
      .forUpdate()
      .executeTakeFirst();
  }

  public async findMatchWithParticipants(
    matchId: string,
  ): Promise<MatchWithParticipants | undefined> {
    const match = await this.findMatch(matchId);

    if (!match) {
      return undefined;
    }

    const participants = await this.executor
      .selectFrom("match_participants")
      .selectAll()
      .where("match_id", "=", matchId)
      .orderBy("slot", "asc")
      .execute();

    return { match, participants };
  }

  public async transitionMatch(
    matchId: string,
    status: Exclude<MatchStatus, "OPEN">,
  ): Promise<void> {
    await this.executor
      .updateTable("matches")
      .set({
        status,
        ended_at: sql<Date>`now()`,
        next_player_id: null,
        completion_reason: status === "COMPLETED" ? "DRAW" : "CANCELLED",
      })
      .where("id", "=", matchId)
      .where("status", "=", "OPEN")
      .executeTakeFirstOrThrow();
  }

  public async recordMove(
    matchId: string,
    playerId: string,
    position: number,
    mark: "X" | "O",
    board: string,
    nextPlayerId: string | null,
    winnerPlayerId: string | null,
    completionReason: "WIN" | "DRAW" | null,
  ): Promise<void> {
    const moveNumber = board.split("").filter((cell) => cell !== ".").length;

    await this.executor
      .insertInto("match_moves")
      .values({
        match_id: matchId,
        player_id: playerId,
        position,
        mark,
        move_number: moveNumber,
      })
      .execute();
    await this.executor
      .updateTable("matches")
      .set({
        board,
        next_player_id: nextPlayerId,
        winner_player_id: winnerPlayerId,
        status: completionReason ? "COMPLETED" : "OPEN",
        completion_reason: completionReason,
        ended_at: completionReason ? sql<Date>`now()` : null,
      })
      .where("id", "=", matchId)
      .where("status", "=", "OPEN")
      .executeTakeFirstOrThrow();
  }

  public async clearActiveMatch(matchId: string): Promise<void> {
    await this.executor
      .updateTable("players")
      .set({ active_match_id: null })
      .where("active_match_id", "=", matchId)
      .execute();
  }
}
