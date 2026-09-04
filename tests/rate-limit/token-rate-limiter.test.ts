import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGatewayDatabase, type GatewayDatabase } from "../../src/db/index.js";
import {
  GatewayStorageError,
  InvalidRequestError,
  RateLimitExceededError,
} from "../../src/errors/gateway-error.js";
import { SQLiteTokenRateLimiter } from "../../src/rate-limit/token-rate-limiter.js";

describe("token-aware sliding-window rate limiter", () => {
  let directory: string;
  let filename: string;
  let database: GatewayDatabase;
  let now: number;
  let limiter: SQLiteTokenRateLimiter;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gateway-rate-limit-"));
    filename = join(directory, "usage.sqlite");
    now = 1_000_000;
    database = createGatewayDatabase({ filename, busyTimeoutMs: 1_000 });
    limiter = new SQLiteTokenRateLimiter(database, { clock: () => now });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("1. Request below the 50,000 token/minute limit is accepted.", async () => {
    await expect(limiter.reserve("tenant-a-secret", 49_999)).resolves.toBeUndefined();
    expect(limiter.getUsage("tenant-a-secret")).toBe(49_999);
  });

  test("2. Request that exactly reaches 50,000 tokens is accepted.", async () => {
    await expect(limiter.reserve("tenant-a-secret", 50_000)).resolves.toBeUndefined();
    expect(limiter.getUsage("tenant-a-secret")).toBe(50_000);
  });

  test("3. Request that would exceed 50,000 tokens is rejected.", async () => {
    await limiter.reserve("tenant-a-secret", 49_000);
    await expect(limiter.reserve("tenant-a-secret", 1_001)).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  test("4. Rate limits are isolated by tenant/API key.", async () => {
    await limiter.reserve("tenant-a-secret", 50_000);
    await expect(limiter.reserve("tenant-b-secret", 50_000)).resolves.toBeUndefined();
  });

  test("5. Usage from one tenant does not affect another tenant.", async () => {
    await limiter.reserve("tenant-a-secret", 12_345);
    expect(limiter.getUsage("tenant-a-secret")).toBe(12_345);
    expect(limiter.getUsage("tenant-b-secret")).toBe(0);
  });

  test("6. Expired usage older than 60 seconds is evicted.", async () => {
    await limiter.reserve("tenant-a-secret", 50_000);
    now += 60_001;
    await limiter.reserve("tenant-a-secret", 1);
    expect(limiter.getUsage("tenant-a-secret")).toBe(1);
    expect(limiter.getRecordCount("tenant-a-secret")).toBe(1);
  });

  test("7. Boundary behavior at approximately 60 seconds is correct.", async () => {
    await limiter.reserve("tenant-a-secret", 50_000);
    now += 59_999;
    await expect(limiter.reserve("tenant-a-secret", 1)).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    now += 1;
    await expect(limiter.reserve("tenant-a-secret", 50_000)).resolves.toBeUndefined();
    expect(limiter.getRecordCount("tenant-a-secret")).toBe(1);
  });

  test("8. Multiple usage records inside the window are summed correctly.", async () => {
    await limiter.reserve("tenant-a-secret", 10_000);
    now += 10_000;
    await limiter.reserve("tenant-a-secret", 15_000);
    now += 10_000;
    await limiter.reserve("tenant-a-secret", 25_000);
    expect(limiter.getUsage("tenant-a-secret")).toBe(50_000);
    await expect(limiter.reserve("tenant-a-secret", 1)).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  test("9. Token usage is persisted in SQLite.", async () => {
    await limiter.reserve("tenant-a-secret", 123);
    expect(readFileSync(filename).length).toBeGreaterThan(0);
    expect(limiter.getRecordCount("tenant-a-secret")).toBe(1);
    expect(readFileSync(filename, "utf8")).not.toContain("tenant-a-secret");
  });

  test("10. Rate limiter state survives a new database connection/process-style recreation.", async () => {
    await limiter.reserve("tenant-a-secret", 49_999);
    database.close();
    database = createGatewayDatabase({ filename });
    limiter = new SQLiteTokenRateLimiter(database, { clock: () => now });
    expect(limiter.getUsage("tenant-a-secret")).toBe(49_999);
    await expect(limiter.reserve("tenant-a-secret", 2)).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  test("11. Concurrent requests cannot both bypass the token limit.", async () => {
    await limiter.reserve("tenant-a-secret", 40_000);
    const secondDatabase = createGatewayDatabase({ filename, busyTimeoutMs: 1_000 });
    const secondLimiter = new SQLiteTokenRateLimiter(secondDatabase, { clock: () => now });
    try {
      const results = await Promise.allSettled([
        limiter.reserve("tenant-a-secret", 10_000),
        secondLimiter.reserve("tenant-a-secret", 10_000),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(limiter.getUsage("tenant-a-secret")).toBe(50_000);
    } finally {
      secondDatabase.close();
    }
  });

  test("12. Failed or rejected reservations do not corrupt usage state.", async () => {
    await limiter.reserve("tenant-a-secret", 49_000);
    await expect(limiter.reserve("tenant-a-secret", 2_000)).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    expect(limiter.getUsage("tenant-a-secret")).toBe(49_000);
    expect(limiter.getRecordCount("tenant-a-secret")).toBe(1);
  });

  test("13. Invalid/negative token counts are rejected.", async () => {
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(limiter.reserve("tenant-a-secret", invalid)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
    }
    expect(limiter.getRecordCount("tenant-a-secret")).toBe(0);
  });

  test("14. Zero-token behavior is explicitly defined and tested.", async () => {
    await expect(limiter.reserve("tenant-a-secret", 0)).resolves.toBeUndefined();
    expect(limiter.getUsage("tenant-a-secret")).toBe(0);
    expect(limiter.getRecordCount("tenant-a-secret")).toBe(0);
  });

  test("15. SQLite transaction failures produce a safe gateway error.", async () => {
    database.close();
    await expect(limiter.reserve("do-not-leak-this-key", 1)).rejects.toEqual(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: "The gateway could not process the request.",
        status: 500,
      }),
    );
    try {
      await limiter.reserve("do-not-leak-this-key", 1);
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayStorageError);
      expect(String(error)).not.toContain("do-not-leak-this-key");
      expect(String(error)).not.toContain(filename);
      expect(String(error)).not.toContain("SELECT");
    }
  });
});
