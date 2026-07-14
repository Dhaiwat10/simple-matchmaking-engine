export type QueueEntryView = {
  id: string;
  createdAt: string;
};

export type MatchParticipantView = {
  playerId: string;
  slot: 1 | 2;
};

export type MatchStatus = "OPEN" | "COMPLETED" | "CANCELLED";

export type TicTacToeMark = "X" | "O";

export type GameOutcome = "IN_PROGRESS" | "WIN" | "DRAW" | "CANCELLED";

export type TicTacToeGameView = {
  board: [
    TicTacToeMark | null,
    TicTacToeMark | null,
    TicTacToeMark | null,
    TicTacToeMark | null,
    TicTacToeMark | null,
    TicTacToeMark | null,
    TicTacToeMark | null,
    TicTacToeMark | null,
    TicTacToeMark | null,
  ];
  nextPlayerId: string | null;
  winnerPlayerId: string | null;
  outcome: GameOutcome;
};

export type MatchView = {
  id: string;
  status: MatchStatus;
  participants: [MatchParticipantView, MatchParticipantView];
  createdAt: string;
  endedAt: string | null;
  game: TicTacToeGameView;
};

export type IdleStatus = {
  state: "IDLE";
};

export type QueuedStatus = {
  state: "QUEUED";
  queueEntry: QueueEntryView;
};

export type MatchedStatus = {
  state: "MATCHED";
  match: MatchView;
};

export type MatchmakingStatus = IdleStatus | QueuedStatus | MatchedStatus;

export type JoinQueueResult =
  | {
      outcome: "ALREADY_QUEUED" | "QUEUED";
      status: QueuedStatus;
    }
  | {
      outcome: "MATCHED";
      status: MatchedStatus;
    };

export const DEFAULT_MATCHMAKING_ADVISORY_LOCK = [481516, 1] as const;
