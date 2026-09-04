import { GatewayError, type GatewayErrorCode } from "./gateway-error.js";
import type { GatewayErrorBody } from "../types/index.js";

export interface PublicGatewayErrorResponse {
  status: number;
  body: GatewayErrorBody;
}

const PUBLIC_ERRORS: Record<GatewayErrorCode, { status: number; message: string }> = {
  INVALID_REQUEST: { status: 400, message: "The request is invalid." },
  RATE_LIMIT_EXCEEDED: { status: 429, message: "Token rate limit exceeded." },
  PROVIDER_UNAVAILABLE: { status: 502, message: "The model provider is unavailable." },
  INTERNAL_ERROR: { status: 500, message: "An internal gateway error occurred." },
};

export function toPublicGatewayError(error: unknown): PublicGatewayErrorResponse {
  if (error instanceof GatewayError) {
    const safeError = PUBLIC_ERRORS[error.code];
    if (safeError) return response(error.code, safeError.status, safeError.message);
  }

  return response("INTERNAL_ERROR", 500, PUBLIC_ERRORS.INTERNAL_ERROR.message);
}

function response(code: GatewayErrorCode, status: number, message: string): PublicGatewayErrorResponse {
  return {
    status,
    body: {
      error: { code, message },
    },
  };
}