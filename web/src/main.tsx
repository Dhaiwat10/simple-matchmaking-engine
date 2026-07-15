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
    void refresh();
    const timer = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!viewedMatch || viewedMatch.status !== "OPEN") return;
    const timer = window.setInterval(() => {
      void api<Match>(`/v1/matches/${viewedMatch.id}`)
        .then(setViewedMatch)
        .catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [viewedMatch?.id, viewedMatch?.status]);

  const yourMark = useMemo(() => {
    if (!viewedMatch) return null;
    return viewedMatch.participants.find(
      (participant) => participant.playerId === id,
    )?.slot === 1
      ? "X"
      : "O";
  }, [viewedMatch]);

  const join = async () => {
    setError(null);
    try {
      const nextStatus = await api<Status>("/v1/queue", { method: "POST" });
      setStatus(nextStatus);
      if (nextStatus.state === "MATCHED") setViewedMatch(nextStatus.match);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to join queue",
      );
    }
  };

  const move = async (position: number) => {
    if (!viewedMatch || viewedMatch.game.nextPlayerId !== id) return;
    setError(null);
    try {
      setViewedMatch(
        await api<Match>(`/v1/matches/${viewedMatch.id}/moves`, {
          method: "POST",
          body: JSON.stringify({ position }),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Move was rejected");
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
        {error && <p className="error">{error}</p>}
        {!viewedMatch || viewedMatch.status !== "OPEN" ? (
          <div className="actions">
            <button
              onClick={() => void join()}
              disabled={status.state === "QUEUED"}
            >
              {status.state === "QUEUED" ? "Finding game…" : "Find game"}
            </button>
            {status.state === "QUEUED" && (
              <button
                className="secondary"
                onClick={() =>
                  api("/v1/queue", { method: "DELETE" }).then(refresh)
                }
              >
                Leave queue
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="turn">
              You are <strong>{yourMark}</strong>.{" "}
              {viewedMatch.game.nextPlayerId === id
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
                    Boolean(mark) || viewedMatch.game.nextPlayerId !== id
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
