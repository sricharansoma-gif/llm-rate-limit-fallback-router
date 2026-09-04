import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { createGatewayDatabase, type GatewayDatabase } from "../../src/db/index.js";
import { ProviderHttpError, type ModelProvider } from "../../src/providers/provider.js";
import { SQLiteTokenRateLimiter } from "../../src/rate-limit/token-rate-limiter.js";
import { ProviderFallbackRouter } from "../../src/router/fallback-router.js";
import type { GatewayResponse } from "../../src/types/index.js";

describe("LLM gateway integration", () => {
  let directory: string;
  let database: GatewayDatabase;
  let limiter: SQLiteTokenRateLimiter;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gateway-integration-"));
    database = createGatewayDatabase({ filename: join(directory, "usage.sqlite") });
    limiter = new SQLiteTokenRateLimiter(database, { limit: 100, clock: () => 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("39. Allowed request -> rate limiter -> primary -> success.", async () => {
    const primary = provider(() => Promise.resolve(result("primary", "hello")));
    const fallback = provider(() => Promise.resolve(result("fallback", "unused")));

    const response = await post(limiter, primary, fallback, "tenant-a", 25);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(result("primary", "hello"));
    expect(limiter.getUsage("tenant-a")).toBe(25);
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  test("40. Rate-limited request stops before provider invocation.", async () => {
    await limiter.reserve("tenant-a", 100);
    const primary = provider(() => Promise.resolve(result("primary", "unused")));
    const fallback = provider(() => Promise.resolve(result("fallback", "unused")));

    const response = await post(limiter, primary, fallback, "tenant-a", 1);

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Token rate limit exceeded." },
    });
    expect(primary.complete).not.toHaveBeenCalled();
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  test("41. Allowed request -> primary 429 -> fallback -> success.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(429, "private body")));
    const fallback = provider(() => Promise.resolve(result("fallback", "recovered")));

    const response = await post(limiter, primary, fallback, "tenant-a", 10);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(result("fallback", "recovered"));
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).toHaveBeenCalledOnce();
  });

  test("42. Allowed request -> primary timeout -> fallback -> success.", async () => {
    const primary = provider(() => new Promise<GatewayResponse>(() => undefined));
    const fallback = provider(() => Promise.resolve(result("fallback", "after timeout")));
    const response = await post(limiter, primary, fallback, "tenant-a", 10, 5);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(result("fallback", "after timeout"));
    expect(fallback.complete).toHaveBeenCalledOnce();
  });

  test("43. Allowed request -> primary failure/fallback failure -> sanitized error.", async () => {
    const secrets = [
      "raw provider body",
      "fake stack trace",
      "https://internal-provider.example/v1",
      "sk-test-secret-key",
      "/Users/private/gateway.sqlite",
      "SQLITE_BUSY",
      "SELECT * FROM token_usage",
      "ProviderHttpError",
    ];
    const primary = provider(() => Promise.reject(new ProviderHttpError(429, secrets[0])));
    const fallback = provider(() => {
      const error = new Error(secrets.slice(2).join(" "));
      error.stack = secrets[1]!;
      return Promise.reject(error);
    });

    const response = await post(limiter, primary, fallback, "tenant-a", 10);
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: { code: "PROVIDER_UNAVAILABLE", message: "The model provider is unavailable." },
    });
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });

  test("44. Two simultaneous requests near the token limit cannot exceed the configured capacity.", async () => {
    await limiter.reserve("tenant-a", 80);
    const primary = provider(() => Promise.resolve(result("primary", "ok")));
    const fallback = provider(() => Promise.resolve(result("fallback", "unused")));
    const app = createApp({ rateLimiter: limiter, router: new ProviderFallbackRouter(primary, fallback) });

    const responses = await Promise.all([
      request(app).post("/v1/completions").set("x-api-key", "tenant-a").send({ prompt: "one", tokenCount: 20 }),
      request(app).post("/v1/completions").set("x-api-key", "tenant-a").send({ prompt: "two", tokenCount: 20 }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 429]);
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(fallback.complete).not.toHaveBeenCalled();
    expect(limiter.getUsage("tenant-a")).toBe(100);
    expect(limiter.getRecordCount("tenant-a")).toBe(2);
  });

  test("45. Requests from two different tenants execute independently.", async () => {
    await limiter.reserve("tenant-a", 100);
    const primary = provider((gatewayRequest) =>
      Promise.resolve(result("primary", `response for ${gatewayRequest.prompt}`)),
    );
    const fallback = provider(() => Promise.resolve(result("fallback", "unused")));
    const app = createApp({ rateLimiter: limiter, router: new ProviderFallbackRouter(primary, fallback) });

    const [limited, allowed] = await Promise.all([
      request(app).post("/v1/completions").set("x-api-key", "tenant-a").send({ prompt: "a", tokenCount: 1 }),
      request(app).post("/v1/completions").set("x-api-key", "tenant-b").send({ prompt: "b", tokenCount: 100 }),
    ]);

    expect(limited.status).toBe(429);
    expect(allowed.status).toBe(200);
    expect(allowed.body.output).toBe("response for b");
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(limiter.getUsage("tenant-a")).toBe(100);
    expect(limiter.getUsage("tenant-b")).toBe(100);
  });
});

function post(
  limiter: SQLiteTokenRateLimiter,
  primary: ModelProvider,
  fallback: ModelProvider,
  tenantApiKey: string,
  tokenCount: number,
  timeoutMs = 3_000,
) {
  const app = createApp({
    rateLimiter: limiter,
    router: new ProviderFallbackRouter(primary, fallback, { timeoutMs }),
  });
  return request(app)
    .post("/v1/completions")
    .set("x-api-key", tenantApiKey)
    .send({ prompt: "hello", tokenCount });
}

function result(providerName: string, output: string): GatewayResponse {
  return { provider: providerName, output, usage: { totalTokens: 1 } };
}

function provider(complete: ModelProvider["complete"]): ModelProvider {
  return { name: "fake", complete: vi.fn(complete) };
}
