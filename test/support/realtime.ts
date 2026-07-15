import type { TokenRequest } from "ably";

import type { MatchView } from "../../src/domain/matchmaking.js";
import type {
  MatchmakingMetrics,
  RealtimeGateway,
} from "../../src/realtime/gateway.js";

export type RealtimePublication =
  | { type: "match"; match: MatchView }
  | { type: "metrics"; metrics: MatchmakingMetrics };

export class TestRealtimeGateway implements RealtimeGateway {
  public readonly publications: RealtimePublication[] = [];

  public async createTokenRequest(playerId: string): Promise<TokenRequest> {
    return {
      capability: JSON.stringify({
        [`player:${playerId}`]: ["subscribe"],
        "matchmaking:metrics": ["subscribe"],
      }),
      clientId: playerId,
      keyName: "test-key",
      mac: "test-mac",
      nonce: "test-nonce",
      timestamp: 0,
      ttl: 900000,
    };
  }

  public async publishMatch(match: MatchView): Promise<void> {
    this.publications.push({ type: "match", match });
  }

  public async publishMetrics(metrics: MatchmakingMetrics): Promise<void> {
    this.publications.push({ type: "metrics", metrics });
  }
}
