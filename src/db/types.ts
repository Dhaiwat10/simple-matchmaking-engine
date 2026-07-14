import type { ColumnType, Generated } from "kysely";

export type QueueEntryState = "QUEUED" | "MATCHED" | "CANCELLED";
export type PersistedMatchStatus = "OPEN" | "COMPLETED" | "CANCELLED";
export type MatchCompletionReason = "WIN" | "DRAW" | "CANCELLED";

type NullableUuid = ColumnType<
  string | null,
  string | null | undefined,
  string | null
>;
type Timestamp = Generated<Date>;

export interface PlayersTable {
  id: Generated<string>;
  active_match_id: NullableUuid;
  created_at: Timestamp;
}

export interface QueueEntriesTable {
  id: Generated<string>;
  player_id: string;
  state: QueueEntryState;
  match_id: NullableUuid;
  created_at: Timestamp;
  resolved_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface MatchesTable {
  id: Generated<string>;
  status: PersistedMatchStatus;
  created_at: Timestamp;
  ended_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  board: Generated<string>;
  next_player_id: NullableUuid;
  winner_player_id: NullableUuid;
  completion_reason: ColumnType<
    MatchCompletionReason | null,
    MatchCompletionReason | null | undefined,
    MatchCompletionReason | null
  >;
}

export interface MatchParticipantsTable {
  match_id: string;
  player_id: string;
  slot: 1 | 2;
}

export interface MatchMovesTable {
  id: Generated<string>;
  match_id: string;
  player_id: string;
  move_number: number;
  position: number;
  mark: "X" | "O";
  created_at: Timestamp;
}

export interface Database {
  players: PlayersTable;
  queue_entries: QueueEntriesTable;
  matches: MatchesTable;
  match_participants: MatchParticipantsTable;
  match_moves: MatchMovesTable;
}
