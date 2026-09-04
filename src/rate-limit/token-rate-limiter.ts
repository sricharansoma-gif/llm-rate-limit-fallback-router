import { createHash } from "node:crypto";
import type { GatewayDatabase, SqliteDatabase } from "../db/index.js";
import {
  GatewayError,
  GatewayStorageError,
  InvalidRequestError,
  RateLimitExceededError,
} from "../errors/gateway-error.js";

export interface TokenRateLimiter {
  reserve(tenantApiKey: string, tokenCount: number): Promise<void>;
}

export interface TokenRateLimiterOptions {
  limit?: number;
  windowMs?: number;
  clock?: () => number;
}

interface TotalRow {
  total: number;
}

interface CountRow {
  count: number;
}

export class SQLiteTokenRateLimiter implements TokenRateLimiter {
  private readonly connection: SqliteDatabase;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(database: GatewayDatabase, options: TokenRateLimiterOptions = {}) {
    this.connection = database.connection;
    this.limit = options.limit ?? 50_000;
    this.windowMs = options.windowMs ?? 60_000;
    this.clock = options.clock ?? Date.now;

    if (!Number.isSafeInteger(this.limit) || this.limit <= 0) {
      throw new InvalidRequestError("Rate limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs <= 0) {
      throw new InvalidRequestError("Rate-limit window must be a positive integer.");
    }
  }

  async reserve(tenantApiKey: string, tokenCount: number): Promise<void> {
    this.validateReservation(tenantApiKey, tokenCount);
    if (tokenCount === 0) return;

    const tenantId = tenantIdentifier(tenantApiKey);
    const now = this.clock();
    if (!Number.isSafeInteger(now)) {
      throw new InvalidRequestError("Clock must return an integer millisecond timestamp.");
    }
    const cutoff = now - this.windowMs;

    try {
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        // Exact cutoff records are expired: active records satisfy timestamp > cutoff.
        this.connection
          .prepare("DELETE FROM token_usage WHERE tenant_id = ? AND timestamp_ms <= ?")
          .run(tenantId, cutoff);

        const row = this.connection
          .prepare(
            "SELECT COALESCE(SUM(token_count), 0) AS total FROM token_usage WHERE tenant_id = ? AND timestamp_ms > ?",
          )
          .get(tenantId, cutoff) as TotalRow;

        if (row.total + tokenCount > this.limit) {
          throw new RateLimitExceededError();
        }

        this.connection
          .prepare("INSERT INTO token_usage (tenant_id, token_count, timestamp_ms) VALUES (?, ?, ?)")
          .run(tenantId, tokenCount, now);
        this.connection.exec("COMMIT");
      } catch (error) {
        if (this.connection.inTransaction) this.connection.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayStorageError();
    }
  }

  /** Aggregate inspection without exposing tenant credentials or storage details. */
  getUsage(tenantApiKey: string, atMs = this.clock()): number {
    this.validateTenant(tenantApiKey);
    try {
      const row = this.connection
        .prepare(
          "SELECT COALESCE(SUM(token_count), 0) AS total FROM token_usage WHERE tenant_id = ? AND timestamp_ms > ?",
        )
        .get(tenantIdentifier(tenantApiKey), atMs - this.windowMs) as TotalRow;
      return row.total;
    } catch {
      throw new GatewayStorageError();
    }
  }

  /** Record count is exposed for verifying zero-token and rejection semantics. */
  getRecordCount(tenantApiKey: string): number {
    this.validateTenant(tenantApiKey);
    try {
      const row = this.connection
        .prepare("SELECT COUNT(*) AS count FROM token_usage WHERE tenant_id = ?")
        .get(tenantIdentifier(tenantApiKey)) as CountRow;
      return row.count;
    } catch {
      throw new GatewayStorageError();
    }
  }

  private validateReservation(tenantApiKey: string, tokenCount: number): void {
    this.validateTenant(tenantApiKey);
    if (!Number.isFinite(tokenCount) || !Number.isSafeInteger(tokenCount) || tokenCount < 0) {
      throw new InvalidRequestError("Token count must be a non-negative integer.");
    }
  }

  private validateTenant(tenantApiKey: string): void {
    if (typeof tenantApiKey !== "string" || tenantApiKey.length === 0) {
      throw new InvalidRequestError("A tenant API key is required.");
    }
  }
}

function tenantIdentifier(tenantApiKey: string): string {
  return createHash("sha256").update(tenantApiKey).digest("hex");
}
