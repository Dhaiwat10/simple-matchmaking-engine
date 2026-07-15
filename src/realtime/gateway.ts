import * as Ably from "ably";

import type { MatchView } from "../domain/matchmaking.js";

export type MatchmakingMetrics = {
  queuedPlayers: number;
  activeMatches: number;
};

export interface RealtimeGateway {
  createTokenRequest(playerId: string): Promise<Ably.TokenRequest>;
  publishMatch(match: MatchView): Promise<void>;
  publishMetrics(metrics: MatchmakingMetrics): Promise<void>;
}

export class AblyRealtimeGateway implements RealtimeGateway {
  private readonly client: Ably.Rest;

  public constructor(apiKey: string) {
    this.client = new Ably.Rest({ key: apiKey });
  }

  public async createTokenRequest(
    playerId: string,
  ): Promise<Ably.TokenRequest> {
    return this.client.auth.createTokenRequest({
      clientId: playerId,
      capability: {
        [`player:${playerId}`]: ["subscribe"],
        "matchmaking:metrics": ["subscribe"],
      },
      ttl: 15 * 60 * 1000,
    });
  }

  public async publishMatch(match: MatchView): Promise<void> {
    await Promise.all(
      match.participants.map(async ({ playerId }) =>
        this.client.channels
          .get(`player:${playerId}`)
          .publish("match.updated", match),
      ),
    );
  }

  public async publishMetrics(metrics: MatchmakingMetrics): Promise<void> {
    await this.client.channels
      .get("matchmaking:metrics")
      .publish("metrics.updated", metrics);
  }
}
