export type DomainErrorCode =
  | "MATCH_IN_PROGRESS"
  | "MATCH_NOT_FOUND"
  | "MATCH_FORBIDDEN"
  | "MATCH_ALREADY_TERMINAL"
  | "NOT_YOUR_TURN"
  | "INVALID_MOVE";

const messages: Record<DomainErrorCode, string> = {
  MATCH_IN_PROGRESS: "Player already has an open match",
  MATCH_NOT_FOUND: "Match not found",
  MATCH_FORBIDDEN: "Player is not a participant in this match",
  MATCH_ALREADY_TERMINAL: "Match is already terminal",
  NOT_YOUR_TURN: "It is not this player's turn",
  INVALID_MOVE: "Move is not valid for the current board",
};

export class DomainError extends Error {
  public readonly code: DomainErrorCode;

  public constructor(code: DomainErrorCode) {
    super(messages[code]);
    this.name = "DomainError";
    this.code = code;
  }
}
