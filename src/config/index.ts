export interface GatewayConfig {
  port: number;
  sqlitePath: string;
  tokenLimitPerMinute: number;
  rateLimitWindowMs: number;
  primaryTimeoutMs: number;
}

export const DEFAULT_GATEWAY_CONFIG: Readonly<GatewayConfig> = {
  port: 3000,
  sqlitePath: "./data/gateway.sqlite",
  tokenLimitPerMinute: 50_000,
  rateLimitWindowMs: 60_000,
  primaryTimeoutMs: 3_000,
};
