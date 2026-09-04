import type { GatewayRequest, GatewayResponse } from "../types/index.js";

export interface ModelProvider {
  readonly name: string;
  complete(request: GatewayRequest, signal?: AbortSignal): Promise<GatewayResponse>;
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    message = "Provider request failed",
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}
