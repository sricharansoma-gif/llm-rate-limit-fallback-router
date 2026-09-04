export type GatewayErrorCode =
  | "INVALID_REQUEST"
  | "RATE_LIMIT_EXCEEDED"
  | "PROVIDER_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface SafeGatewayError {
  code: GatewayErrorCode;
  message: string;
  status: number;
}

export class GatewayError extends Error implements SafeGatewayError {
  constructor(
    public readonly code: GatewayErrorCode,
    public readonly message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export class InvalidRequestError extends GatewayError {
  constructor(message = "The request is invalid.") {
    super("INVALID_REQUEST", message, 400);
    this.name = "InvalidRequestError";
  }
}

export class RateLimitExceededError extends GatewayError {
  constructor() {
    super("RATE_LIMIT_EXCEEDED", "Token rate limit exceeded.", 429);
    this.name = "RateLimitExceededError";
  }
}

export class GatewayStorageError extends GatewayError {
  constructor() {
    super("INTERNAL_ERROR", "The gateway could not process the request.", 500);
    this.name = "GatewayStorageError";
  }
}
