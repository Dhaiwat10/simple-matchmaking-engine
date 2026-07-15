import * as Ably from "ably";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type Mark = "X" | "O";
type Match = {
  id: string;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  participants: { playerId: string; slot: 1 | 2 }[];
  game: {
    board: (Mark | null)[];
    nextPlayerId: string | null;
    winnerPlayerId: string | null;
    outcome: "IN_PROGRESS" | "WIN" | "DRAW" | "CANCELLED";
  };
};
type Status =
  | { state: "IDLE" }
  | { state: "QUEUED"; queueEntry: { id: string } }
  | { state: "MATCHED"; match: Match };

function playerId(): string {
  const stored = localStorage.getItem("matchmaking-player-id");
  if (stored) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem("matchmaking-player-id", created);
  return created;
}

const id = playerId();

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Player-Id", id);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
  });
  if (!response.ok)
    throw new Error((await response.json()).error?.message ?? "Request failed");
  return response.status === 204 ? (undefined as T) : response.json();
}

type QueueMetrics = { queuedPlayers: number; activeMatches: number };

function App() {
  const [status, setStatus] = useState<Status>({ state: "IDLE" });
  const [metrics, setMetrics] = useState<QueueMetrics>({
    queuedPlayers: 0,
    activeMatches: 0,
  });
  const [viewedMatch, setViewedMatch] = useState<Match | null>(null);
  const [realtimeState, setRealtimeState] = useState("connecting");
  const [queueMutationPending, setQueueMutationPending] = useState(false);
  const [pendingMove, setPendingMove] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextMetrics] = await Promise.all([
        api<Status>("/v1/matchmaking/status"),
        api<QueueMetrics>("/v1/matchmaking/metrics"),
      ]);
      setStatus(nextStatus);
      setMetrics(nextMetrics);
      if (nextStatus.state === "MATCHED") setViewedMatch(nextStatus.match);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to refresh matchmaking",
      );
    }
  }, []);

  useEffect(() => {
    const client = new Ably.Realtime({
      authUrl: "/v1/realtime/token",
      authHeaders: { "X-Player-Id": id },
    });
    const playerChannel = client.channels.get(`player:${id}`);
    const metricsChannel = client.channels.get("matchmaking:metrics");

    client.connection.on((stateChange) => {
      setRealtimeState(stateChange.current);
    });
    client.connection.on("connected", () => {
      void refresh();
    });
    void Promise.all([
      playerChannel.subscribe("match.updated", (message) => {
        const match = message.data as Match;
        setViewedMatch(match);
        setStatus({ state: "MATCHED", match });
      }),
      metricsChannel.subscribe("metrics.updated", (message) => {
        setMetrics(message.data as QueueMetrics);
      }),
    ]).catch((reason: unknown) => {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to subscribe to live updates",
      );
    });

    return () => {
      client.close();
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const yourMark = useMemo(() => {
    if (!viewedMatch) return null;
    return viewedMatch.participants.find(
      (participant) => participant.playerId === id,
    )?.slot === 1
      ? "X"
      : "O";
  }, [viewedMatch]);

  const join = async () => {
    if (queueMutationPending || status.state === "QUEUED") return;

    const previousStatus = status;
    const previousMatch = viewedMatch;
    setError(null);
    setQueueMutationPending(true);
    setStatus({ state: "QUEUED", queueEntry: { id: "pending" } });
    setViewedMatch(null);

    try {
      const nextStatus = await api<Status>("/v1/queue", { method: "POST" });
      setStatus(nextStatus);
      setViewedMatch(nextStatus.state === "MATCHED" ? nextStatus.match : null);
    } catch (reason) {
      setStatus(previousStatus);
      setViewedMatch(previousMatch);
      setError(
        reason instanceof Error ? reason.message : "Unable to join queue",
      );
    } finally {
      setQueueMutationPending(false);
    }
  };

  const move = async (position: number) => {
    if (
      !viewedMatch ||
      pendingMove !== null ||
      viewedMatch.game.nextPlayerId !== id ||
      viewedMatch.game.board[position]
    ) {
      return;
    }

    const participant = viewedMatch.participants.find(
      ({ playerId }) => playerId === id,
    );
    const opponent = viewedMatch.participants.find(
      ({ playerId }) => playerId !== id,
    );
    if (!participant || !opponent) return;

    const mark: Mark = participant.slot === 1 ? "X" : "O";
    const previousMatch = viewedMatch;
    const optimisticMatch: Match = {
      ...previousMatch,
      game: {
        ...previousMatch.game,
        board: previousMatch.game.board.map((cell, index) =>
          index === position ? mark : cell,
        ),
        nextPlayerId: opponent.playerId,
      },
    };
    setError(null);
    setPendingMove(position);
    setViewedMatch(optimisticMatch);

    try {
      const confirmedMatch = await api<Match>(
        `/v1/matches/${previousMatch.id}/moves`,
        {
          method: "POST",
          body: JSON.stringify({ position }),
        },
      );
      setViewedMatch((currentMatch) =>
        currentMatch?.id === optimisticMatch.id &&
        currentMatch.game.nextPlayerId === optimisticMatch.game.nextPlayerId &&
        currentMatch.game.board[position] === mark
          ? confirmedMatch
          : currentMatch,
      );
    } catch (reason) {
      setViewedMatch((currentMatch) =>
        currentMatch?.id === optimisticMatch.id &&
        currentMatch.game.nextPlayerId === optimisticMatch.game.nextPlayerId &&
        currentMatch.game.board[position] === mark
          ? previousMatch
          : currentMatch,
      );
      setError(reason instanceof Error ? reason.message : "Move was rejected");
    } finally {
      setPendingMove(null);
    }
  };

  const leave = async () => {
    if (queueMutationPending || status.state !== "QUEUED") return;

    const previousStatus = status;
    const previousMatch = viewedMatch;
    setError(null);
    setQueueMutationPending(true);
    setStatus({ state: "IDLE" });
    setViewedMatch(null);

    try {
      await api<void>("/v1/queue", { method: "DELETE" });
    } catch (reason) {
      setStatus(previousStatus);
      setViewedMatch(previousMatch);
      setError(
        reason instanceof Error ? reason.message : "Unable to leave queue",
      );
    } finally {
      setQueueMutationPending(false);
    }
  };

  const title =
    status.state === "QUEUED"
      ? "Searching for another player…"
      : viewedMatch?.status === "OPEN"
        ? "Match found — play tic-tac-toe"
        : "One-on-one matchmaking, stripped to the core";
  const outcome = viewedMatch?.game.outcome;
  const result =
    outcome === "WIN"
      ? viewedMatch?.game.winnerPlayerId === id
        ? "You won."
        : "You lost."
      : outcome === "DRAW"
        ? "Draw game."
        : outcome === "CANCELLED"
          ? "Match cancelled."
          : null;

  return (
    <main>
      <section className="card">
        <p className="eyebrow">QUEUE & PLAY</p>
        <h1>{title}</h1>
        <p className="identity">Your temporary player ID: {id.slice(0, 8)}</p>
        <p className="identity">
          {metrics.queuedPlayers} searching · {metrics.activeMatches} live
          matches
        </p>
        <p className="identity">
          {realtimeState === "connected"
            ? "Live updates connected"
            : `Live updates: ${realtimeState}`}
        </p>
        {error && <p className="error">{error}</p>}
        {!viewedMatch || viewedMatch.status !== "OPEN" ? (
          <div className="actions">
            <button
              onClick={() => void join()}
              disabled={queueMutationPending || status.state === "QUEUED"}
            >
              {queueMutationPending
                ? status.state === "QUEUED"
                  ? "Finding game…"
                  : "Leaving queue…"
                : "Find game"}
            </button>
            {status.state === "QUEUED" && (
              <button className="secondary" onClick={() => void leave()}>
                Leave queue
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="turn">
              You are <strong>{yourMark}</strong>.{" "}
              {pendingMove !== null
                ? "Sending move…"
                : viewedMatch.game.nextPlayerId === id
                  ? "Your move."
                  : "Opponent is choosing…"}
            </p>
            <div className="board">
              {viewedMatch.game.board.map((mark, position) => (
                <button
                  key={position}
                  aria-label={
                    mark
                      ? `Cell ${position + 1}: ${mark}`
                      : `Cell ${position + 1}`
                  }
                  onClick={() => void move(position)}
                  disabled={
                    pendingMove !== null ||
                    Boolean(mark) ||
                    viewedMatch.game.nextPlayerId !== id
                  }
                >
                  {mark}
                </button>
              ))}
            </div>
          </>
        )}
        {result && (
          <div className="result">
            <h2>{result}</h2>
            <button
              disabled={queueMutationPending}
              onClick={() => {
                setViewedMatch(null);
                void join();
              }}
            >
              Play again
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
