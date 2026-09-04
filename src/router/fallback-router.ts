import type { GatewayRequest, GatewayResponse } from "../types/index.js";
import { GatewayError } from "../errors/gateway-error.js";
import { ProviderHttpError, type ModelProvider } from "../providers/provider.js";

export interface FallbackRouter {
  route(request: GatewayRequest): Promise<GatewayResponse>;
}

export interface FallbackRouterOptions {
  timeoutMs?: number;
}

export class ProviderFallbackRouter implements FallbackRouter {
  private readonly timeoutMs: number;

  constructor(
    private readonly primary: ModelProvider,
    private readonly fallback: ModelProvider,
    options: FallbackRouterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new RangeError("Provider timeout must be a non-negative finite number.");
    }
  }

  async route(request: GatewayRequest): Promise<GatewayResponse> {
    const primaryResult = await this.completePrimary(request);
    if (primaryResult.kind === "success") return primaryResult.response;
    if (primaryResult.kind === "error" && primaryResult.error.status !== 429) {
      throw primaryResult.error;
    }

    return this.completeFallback(request);
  }

  private completePrimary(request: GatewayRequest): Promise<PrimaryResult> {
    return new Promise((resolve) => {
      let settled = false;
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.timeoutMs);

      const settle = (result: PrimaryResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      let completion: Promise<GatewayResponse>;
      try {
        completion = this.primary.complete(request, controller.signal);
      } catch {
        settle({ kind: "error", error: providerUnavailableError() });
        return;
      }

      Promise.resolve(completion).then(
        (response) => settle({ kind: "success", response }),
        (error: unknown) => {
          if (error instanceof ProviderHttpError && error.status === 429) {
            settle({ kind: "rate-limit" });
            return;
          }
          settle({ kind: "error", error: providerUnavailableError() });
        },
      );
    });
  }

  private async completeFallback(request: GatewayRequest): Promise<GatewayResponse> {
    try {
      return await this.fallback.complete(request);
    } catch {
      throw providerUnavailableError();
    }
  }
}

interface PrimarySuccess {
  kind: "success";
  response: GatewayResponse;
}

interface PrimaryFailure {
  kind: "error";
  error: GatewayError;
}

type PrimaryResult = PrimarySuccess | PrimaryFailure | { kind: "rate-limit" } | { kind: "timeout" };

function providerUnavailableError(): GatewayError {
  return new GatewayError("PROVIDER_UNAVAILABLE", "The model provider is unavailable.", 502);
}
