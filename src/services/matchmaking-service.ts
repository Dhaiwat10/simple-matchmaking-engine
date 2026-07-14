import { Kysely, sql } from "kysely";

import type { Database } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import {
  DEFAULT_MATCHMAKING_ADVISORY_LOCK,
  type JoinQueueResult,
  type MatchmakingStatus,
  type MatchStatus,
  type MatchView,
  type QueuedStatus,
  type TicTacToeMark,
} from "../domain/matchmaking.js";
import {
  MatchmakingRepository,
  type MatchWithParticipants,
  type QueueEntryRow,
} from "../repositories/matchmaking-repository.js";

function toQueuedStatus(entry: QueueEntryRow): QueuedStatus {
  return {
    state: "QUEUED",
    queueEntry: {
      id: entry.id,
      createdAt: entry.created_at.toISOString(),
    },
  };
}

function toMark(cell: string): TicTacToeMark | null {
  return cell === "X" || cell === "O" ? cell : null;
}

const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

function winnerFor(board: readonly string[]): TicTacToeMark | null {
  for (const [first, second, third] of WINNING_LINES) {
    const mark = board[first];

    if (
      mark &&
      mark !== "." &&
      mark === board[second] &&
      mark === board[third]
    ) {
      return mark as TicTacToeMark;
    }
  }

  return null;
}

function toMatchView(matchWithParticipants: MatchWithParticipants): MatchView {
  const { match, participants } = matchWithParticipants;

  if (
    participants.length !== 2 ||
    participants[0]?.slot !== 1 ||
    participants[1]?.slot !== 2
  ) {
    throw new Error(
      `Match ${match.id} does not have exactly two ordered participants`,
    );
  }

  const cells = match.board.split("");

  return {
    id: match.id,
    status: match.status,
    participants: [
      { playerId: participants[0].player_id, slot: 1 },
      { playerId: participants[1].player_id, slot: 2 },
    ],
    createdAt: match.created_at.toISOString(),
    endedAt: match.ended_at?.toISOString() ?? null,
    game: {
      board: [
        toMark(cells[0] ?? "."),
        toMark(cells[1] ?? "."),
        toMark(cells[2] ?? "."),
        toMark(cells[3] ?? "."),
        toMark(cells[4] ?? "."),
        toMark(cells[5] ?? "."),
        toMark(cells[6] ?? "."),
        toMark(cells[7] ?? "."),
        toMark(cells[8] ?? "."),
      ],
      nextPlayerId: match.next_player_id,
      winnerPlayerId: match.winner_player_id,
      outcome:
        match.status === "OPEN"
          ? "IN_PROGRESS"
          : match.status === "CANCELLED"
            ? "CANCELLED"
            : match.completion_reason === "WIN"
              ? "WIN"
              : "DRAW",
    },
  };
}

export class MatchmakingService {
  public constructor(private readonly db: Kysely<Database>) {}

  public async joinQueue(playerId: string): Promise<JoinQueueResult> {
    return this.db.transaction().execute(async (transaction) => {
      const repository = new MatchmakingRepository(transaction);
      await repository.acquireAdvisoryLock(DEFAULT_MATCHMAKING_ADVISORY_LOCK);

      const player = await repository.createOrFetchPlayer(playerId);
      const queuedEntry = await repository.findQueuedEntry(playerId);

      if (queuedEntry) {
        return {
          outcome: "ALREADY_QUEUED",
          status: toQueuedStatus(queuedEntry),
        };
      }

      if (player.active_match_id) {
        throw new DomainError("MATCH_IN_PROGRESS");
      }

      const candidate =
        await repository.findOldestQueuedCandidateExcluding(playerId);

      if (!candidate) {
        const newEntry = await repository.createQueuedEntry(playerId);
        return { outcome: "QUEUED", status: toQueuedStatus(newEntry) };
      }

      if (candidate.active_match_id) {
        throw new Error(
          `Queued player ${candidate.player_id} already has an active match`,
        );
      }

      const match = await repository.createOpenMatch(
        candidate.player_id,
        playerId,
      );
      await repository.markEntryMatched(candidate.id, match.id);
      await repository.createMatchedEntry(playerId, match.id);
      await repository.setActiveMatch(
        [candidate.player_id, playerId],
        match.id,
      );

      const matchWithParticipants = await repository.findMatchWithParticipants(
        match.id,
      );

      if (!matchWithParticipants) {
        throw new Error(`Created match ${match.id} could not be loaded`);
      }

      return {
        outcome: "MATCHED",
        status: { state: "MATCHED", match: toMatchView(matchWithParticipants) },
      };
    });
  }

  public async getStatus(playerId: string): Promise<MatchmakingStatus> {
    const repository = new MatchmakingRepository(this.db);
    const player = await repository.findPlayer(playerId);

    if (!player) {
      return { state: "IDLE" };
    }

    if (player.active_match_id) {
      const matchWithParticipants = await repository.findMatchWithParticipants(
        player.active_match_id,
      );

      if (
        !matchWithParticipants ||
        matchWithParticipants.match.status !== "OPEN"
      ) {
        throw new Error(
          `Player ${playerId} references an invalid active match`,
        );
      }

      return { state: "MATCHED", match: toMatchView(matchWithParticipants) };
    }

    const queuedEntry = await repository.findQueuedEntry(playerId);
    return queuedEntry ? toQueuedStatus(queuedEntry) : { state: "IDLE" };
  }
  public async getQueueMetrics(): Promise<{
    queuedPlayers: number;
    activeMatches: number;
  }> {
    const result = await sql<{
      queued_players: string;
      active_matches: string;
    }>`
      SELECT
        (SELECT count(*) FROM queue_entries WHERE state = 'QUEUED') AS queued_players,
        (SELECT count(*) FROM matches WHERE status = 'OPEN') AS active_matches
    `.execute(this.db);
    const counts = result.rows[0];
    return {
      queuedPlayers: Number(counts?.queued_players ?? 0),
      activeMatches: Number(counts?.active_matches ?? 0),
    };
  }

  public async getMatch(playerId: string, matchId: string): Promise<MatchView> {
    const repository = new MatchmakingRepository(this.db);
    const matchExists = await repository.findMatch(matchId);

    if (!matchExists) {
      throw new DomainError("MATCH_NOT_FOUND");
    }

    if (!(await repository.findParticipant(matchId, playerId))) {
      throw new DomainError("MATCH_FORBIDDEN");
    }

    const matchWithParticipants =
      await repository.findMatchWithParticipants(matchId);

    if (!matchWithParticipants) {
      throw new Error(`Match ${matchId} disappeared during lookup`);
    }

    return toMatchView(matchWithParticipants);
  }

  public async leaveQueue(playerId: string): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const repository = new MatchmakingRepository(transaction);
      await repository.acquireAdvisoryLock(DEFAULT_MATCHMAKING_ADVISORY_LOCK);
      await repository.cancelQueuedEntry(playerId);
    });
  }

  public async endMatch(
    playerId: string,
    matchId: string,
    status: Exclude<MatchStatus, "OPEN">,
  ): Promise<MatchView> {
    return this.db.transaction().execute(async (transaction) => {
      const repository = new MatchmakingRepository(transaction);
      const match = await repository.findMatchForUpdate(matchId);

      if (!match) {
        throw new DomainError("MATCH_NOT_FOUND");
      }

      if (!(await repository.findParticipant(matchId, playerId))) {
        throw new DomainError("MATCH_FORBIDDEN");
      }

      if (match.status !== "OPEN") {
        throw new DomainError("MATCH_ALREADY_TERMINAL");
      }

      await repository.transitionMatch(matchId, status);
      await repository.clearActiveMatch(matchId);

      const matchWithParticipants =
        await repository.findMatchWithParticipants(matchId);

      if (!matchWithParticipants) {
        throw new Error(`Ended match ${matchId} could not be loaded`);
      }

      return toMatchView(matchWithParticipants);
    });
  }
  public async makeMove(
    playerId: string,
    matchId: string,
    position: number,
  ): Promise<MatchView> {
    return this.db.transaction().execute(async (transaction) => {
      const repository = new MatchmakingRepository(transaction);
      const match = await repository.findMatchForUpdate(matchId);

      if (!match) throw new DomainError("MATCH_NOT_FOUND");
      if (!(await repository.findParticipant(matchId, playerId))) {
        throw new DomainError("MATCH_FORBIDDEN");
      }
      if (match.status !== "OPEN")
        throw new DomainError("MATCH_ALREADY_TERMINAL");
      if (match.next_player_id !== playerId)
        throw new DomainError("NOT_YOUR_TURN");

      const board = match.board.split("");
      if (position < 0 || position > 8 || board[position] !== ".") {
        throw new DomainError("INVALID_MOVE");
      }

      const participant = await transaction
        .selectFrom("match_participants")
        .select("slot")
        .where("match_id", "=", matchId)
        .where("player_id", "=", playerId)
        .executeTakeFirstOrThrow();
      const opponent = await transaction
        .selectFrom("match_participants")
        .select("player_id")
        .where("match_id", "=", matchId)
        .where("player_id", "!=", playerId)
        .executeTakeFirstOrThrow();
      const mark: TicTacToeMark = participant.slot === 1 ? "X" : "O";
      board[position] = mark;
      const winner = winnerFor(board);
      const completionReason = winner
        ? "WIN"
        : board.includes(".")
          ? null
          : "DRAW";

      await repository.recordMove(
        matchId,
        playerId,
        position,
        mark,
        board.join(""),
        completionReason ? null : opponent.player_id,
        winner ? playerId : null,
        completionReason,
      );
      if (completionReason) await repository.clearActiveMatch(matchId);

      const updatedMatch = await repository.findMatchWithParticipants(matchId);
      if (!updatedMatch)
        throw new Error(`Moved match ${matchId} could not be loaded`);
      return toMatchView(updatedMatch);
    });
  }
}
