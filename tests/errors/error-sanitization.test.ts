import { describe, expect, test } from "vitest";
import {
  GatewayError,
  GatewayStorageError,
  InvalidRequestError,
  RateLimitExceededError,
} from "../../src/errors/gateway-error.js";
import { toPublicGatewayError } from "../../src/errors/error-response.js";

describe("gateway error standardization and sanitization", () => {
  test("30. Error responses use one standardized JSON structure.", () => {
    expect(toPublicGatewayError(new InvalidRequestError("private details"))).toEqual({
      status: 400,
      body: { error: { code: "INVALID_REQUEST", message: "The request is invalid." } },
    });
  });

  test("31. Raw upstream stack traces are never exposed.", () => {
    const error = new Error("upstream failure");
    error.stack = "fake stack trace at /Users/example/private/gateway.ts";

    expect(JSON.stringify(toPublicGatewayError(error))).not.toContain("fake stack trace");
  });

  test("32. Provider response bodies are not leaked.", () => {
    const error = new GatewayError(
      "PROVIDER_UNAVAILABLE",
      "fake provider response body",
      502,
    );

    expect(JSON.stringify(toPublicGatewayError(error))).not.toContain("fake provider response body");
  });

  test("33. API keys and secrets are not leaked.", () => {
    const error = new GatewayError(
      "INVALID_REQUEST",
      "sk-secret-example-123 Authorization: Bearer secret-value",
      400,
    );

    const serialized = JSON.stringify(toPublicGatewayError(error));
    expect(serialized).not.toContain("sk-secret-example-123");
    expect(serialized).not.toContain("Authorization: Bearer secret-value");
  });

  test("34. Internal SQLite errors are not exposed.", () => {
    const error = new GatewayError("INTERNAL_ERROR", "SQLITE_BUSY: SELECT * FROM token_usage", 500);

    expect(JSON.stringify(toPublicGatewayError(error))).not.toContain("SQLITE_BUSY");
    expect(JSON.stringify(toPublicGatewayError(error))).not.toContain("SELECT * FROM token_usage");
  });

  test("35. Internal file paths are not exposed.", () => {
    const error = new GatewayError("INTERNAL_ERROR", "/Users/example/private/database.sqlite", 500);

    expect(JSON.stringify(toPublicGatewayError(error))).not.toContain(
      "/Users/example/private/database.sqlite",
    );
  });

  test("36. Internal provider URLs are not exposed.", () => {
    const error = new GatewayError(
      "PROVIDER_UNAVAILABLE",
      "https://internal-provider.example/v1",
      502,
    );

    expect(JSON.stringify(toPublicGatewayError(error))).not.toContain(
      "https://internal-provider.example/v1",
    );
  });

  test("37. Unknown unexpected exceptions become a generic safe gateway error.", () => {
    const error = {
      message: "unexpected secret",
      stack: "fake stack trace",
      url: "https://internal-provider.example/v1",
      responseBody: "fake provider response body",
    };

    expect(toPublicGatewayError(error)).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "An internal gateway error occurred." } },
    });
    expect(JSON.stringify(toPublicGatewayError(error))).not.toContain("unexpected secret");
  });

  test("38. Appropriate HTTP status codes are returned.", () => {
    expect(toPublicGatewayError(new InvalidRequestError()).status).toBe(400);
    expect(toPublicGatewayError(new RateLimitExceededError()).status).toBe(429);
    expect(toPublicGatewayError(new GatewayError("PROVIDER_UNAVAILABLE", "unsafe", 400)).status).toBe(
      502,
    );
    expect(toPublicGatewayError(new GatewayStorageError()).status).toBe(500);
    expect(toPublicGatewayError(new Error("unsafe")).status).toBe(500);
  });
});
