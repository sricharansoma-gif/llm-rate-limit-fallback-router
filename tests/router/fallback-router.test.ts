import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayError } from "../../src/errors/gateway-error.js";
import { ProviderHttpError, type ModelProvider } from "../../src/providers/provider.js";
import { ProviderFallbackRouter } from "../../src/router/fallback-router.js";
import type { GatewayRequest, GatewayResponse } from "../../src/types/index.js";

describe("model fallback router", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const request: GatewayRequest = { tenantApiKey: "tenant-key", prompt: "hello", tokenCount: 1 };
  const primaryResponse = response("primary", "primary output");
  const fallbackResponse = response("fallback", "fallback output");

  test("16. Successful primary response is returned without calling fallback.", async () => {
    const primary = provider(() => Promise.resolve(primaryResponse));
    const fallback = provider(() => Promise.resolve(fallbackResponse));

    await expect(new ProviderFallbackRouter(primary, fallback).route(request)).resolves.toEqual(
      primaryResponse,
    );
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  test("17. Primary HTTP 429 causes fallback.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(429, "secret body")));
    const fallback = provider(() => Promise.resolve(fallbackResponse));

    await expect(new ProviderFallbackRouter(primary, fallback).route(request)).resolves.toEqual(
      fallbackResponse,
    );
    expect(fallback.complete).toHaveBeenCalledOnce();
  });

  test("18. Primary timeout after 3000ms causes fallback.", async () => {
    const primary = provider(() => new Promise<GatewayResponse>(() => undefined));
    const fallback = provider(() => Promise.resolve(fallbackResponse));
    const route = new ProviderFallbackRouter(primary, fallback).route(request);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(fallback.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(route).resolves.toEqual(fallbackResponse);
    expect(fallback.complete).toHaveBeenCalledOnce();
  });

  test("19. A primary non-429 4xx error does not incorrectly trigger fallback.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(400, "private body")));
    const fallback = provider(() => Promise.resolve(fallbackResponse));

    await expect(new ProviderFallbackRouter(primary, fallback).route(request)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 502,
    });
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  test("20. A primary 5xx error does not trigger fallback and is safe.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(503, "upstream secret")));
    const fallback = provider(() => Promise.resolve(fallbackResponse));

    await expect(new ProviderFallbackRouter(primary, fallback).route(request)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GatewayError &&
        error.code === "PROVIDER_UNAVAILABLE" &&
        !JSON.stringify(error).includes("upstream secret"),
    );
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  test("21. Fallback success is returned correctly.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(429)));
    const fallback = provider(() => Promise.resolve(fallbackResponse));

    await expect(new ProviderFallbackRouter(primary, fallback).route(request)).resolves.toEqual(
      fallbackResponse,
    );
  });

  test("22. Fallback failure returns a standardized gateway error.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(429)));
    const fallback = provider(() => Promise.reject(new Error("url=https://provider.test key=secret")));

    await expect(new ProviderFallbackRouter(primary, fallback).route(request)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "The model provider is unavailable.",
      status: 502,
    });
  });

  test("23. Primary 429 followed by fallback failure is handled safely.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(429, "raw provider body")));
    const fallback = provider(() => Promise.reject(new Error("fallback stack and API key")));

    await expect(new ProviderFallbackRouter(primary, fallback).route(request)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GatewayError &&
        error.code === "PROVIDER_UNAVAILABLE" &&
        error.message === "The model provider is unavailable.",
    );
  });

  test("24. Primary timeout followed by fallback failure is handled safely.", async () => {
    const primary = provider(() => new Promise<GatewayResponse>(() => undefined));
    const fallback = provider(() => Promise.reject(new Error("fallback internal error")));
    const route = new ProviderFallbackRouter(primary, fallback).route(request);
    const result = expect(route).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 502,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await result;
  });

  test("25. Fallback is called at most once.", async () => {
    const primary = provider(() => Promise.reject(new ProviderHttpError(429)));
    const fallback = provider(() => Promise.resolve(fallbackResponse));

    await new ProviderFallbackRouter(primary, fallback).route(request);
    expect(fallback.complete).toHaveBeenCalledTimes(1);
  });

  test("26. A timed-out primary request cannot later overwrite the fallback response.", async () => {
    let resolvePrimary!: (value: GatewayResponse) => void;
    const primary = provider(
      () => new Promise<GatewayResponse>((resolve) => (resolvePrimary = resolve)),
    );
    const fallback = provider(() => Promise.resolve(fallbackResponse));
    const route = new ProviderFallbackRouter(primary, fallback).route(request);

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(route).resolves.toEqual(fallbackResponse);
    resolvePrimary(primaryResponse);
    await vi.runAllTimersAsync();
    expect(fallbackResponse.output).toBe("fallback output");
  });

  test("27. Race at the 3000ms boundary deterministically favors timeout.", async () => {
    const primary = provider(
      () => new Promise<GatewayResponse>((resolve) => setTimeout(() => resolve(primaryResponse), 3_000)),
    );
    const fallback = provider(() => Promise.resolve(fallbackResponse));
    const route = new ProviderFallbackRouter(primary, fallback).route(request);

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(route).resolves.toEqual(fallbackResponse);
    expect(fallback.complete).toHaveBeenCalledOnce();
  });

  test("28. Timeout timer/resources are cleaned up after primary succeeds.", async () => {
    const primary = provider(() => Promise.resolve(primaryResponse));
    const fallback = provider(() => Promise.resolve(fallbackResponse));

    await new ProviderFallbackRouter(primary, fallback).route(request);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("29. Concurrent gateway requests do not share provider state accidentally.", async () => {
    const primaryDeferred = [deferred<GatewayResponse>(), deferred<GatewayResponse>()];
    let call = 0;
    const primary = provider(() => primaryDeferred[call++]!.promise);
    const fallback = provider(() => Promise.resolve(fallbackResponse));
    const router = new ProviderFallbackRouter(primary, fallback);
    const first = router.route({ ...request, prompt: "first" });
    const second = router.route({ ...request, prompt: "second" });

    primaryDeferred[1]!.resolve(response("primary", "second output"));
    primaryDeferred[0]!.resolve(response("primary", "first output"));
    await expect(first).resolves.toMatchObject({ output: "first output" });
    await expect(second).resolves.toMatchObject({ output: "second output" });
    expect(fallback.complete).not.toHaveBeenCalled();
  });
});

function response(providerName: string, output: string): GatewayResponse {
  return { provider: providerName, output, usage: { totalTokens: 1 } };
}

function provider(complete: ModelProvider["complete"]): ModelProvider {
  return { name: "fake", complete: vi.fn(complete) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
