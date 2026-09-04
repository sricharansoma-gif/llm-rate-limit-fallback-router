import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { toPublicGatewayError } from "./errors/error-response.js";
import { InvalidRequestError } from "./errors/gateway-error.js";
import type { TokenRateLimiter } from "./rate-limit/token-rate-limiter.js";
import type { FallbackRouter } from "./router/fallback-router.js";
import type { GatewayRequest } from "./types/index.js";

export interface AppDependencies {
  rateLimiter: TokenRateLimiter;
  router: FallbackRouter;
}

/** Creates an HTTP gateway whose stateful components are supplied by the caller. */
export function createApp(dependencies?: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  if (dependencies) {
    app.post("/v1/completions", async (request, response, next) => {
      try {
        const completion = parseCompletionRequest(request);
        await dependencies.rateLimiter.reserve(completion.tenantApiKey, completion.tokenCount);
        response.status(200).json(await dependencies.router.route(completion));
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const publicError = toPublicGatewayError(error);
    response.status(publicError.status).json(publicError.body);
  });

  return app;
}

function parseCompletionRequest(request: Request): GatewayRequest {
  const tenantApiKey = request.header("x-api-key");
  const body: unknown = request.body;
  if (
    typeof tenantApiKey !== "string" ||
    tenantApiKey.length === 0 ||
    !isObject(body) ||
    typeof body.prompt !== "string" ||
    body.prompt.length === 0 ||
    !Number.isSafeInteger(body.tokenCount) ||
    (body.tokenCount as number) < 0
  ) {
    throw new InvalidRequestError();
  }

  return { tenantApiKey, prompt: body.prompt, tokenCount: body.tokenCount as number };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
