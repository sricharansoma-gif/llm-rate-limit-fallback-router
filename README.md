# LLM Rate-Limit and Fallback Router

A TypeScript/Express LLM gateway that enforces a persistent per-tenant token sliding window, routes requests to a primary model provider, and falls back to a secondary provider when the primary returns HTTP 429 or exceeds the configured timeout.

The project uses fake providers for deterministic testing. It does not call a real LLM service and does not require API credentials.

## Architecture

```text
Client
  -> POST /v1/completions
  -> Validate x-api-key, prompt, tokenCount
  -> SQLite token reservation
  -> Primary provider
       -> success: return response
       -> HTTP 429: fallback provider
       -> timeout: abort primary and use fallback provider
  -> standardized safe error response on failure
```

## Rate limiting

- Default capacity: 50,000 tokens per tenant API key
- Rolling window: 60,000 ms
- Usage is persisted in on-disk SQLite
- Raw tenant API keys are SHA-256 hashed before persistence
- Accepted reservations use an atomic `BEGIN IMMEDIATE` transaction
- Expired usage is removed inside the transaction before active usage is summed
- A record exactly at `now - 60,000 ms` is expired
- Zero-token requests are accepted without creating a usage record
- Concurrent reservations cannot both observe stale capacity and exceed the configured limit

SQLite uses WAL mode, a busy timeout, and an index on tenant and timestamp for efficient rolling-window queries.

## Provider fallback

- Primary success returns immediately without calling fallback
- Primary HTTP 429 triggers the fallback provider exactly once
- Primary requests that do not complete within 3,000 ms are aborted with `AbortController` and trigger fallback
- Non-429 4xx and 5xx responses do not automatically trigger fallback
- Late primary settlement after timeout cannot overwrite the fallback result
- Timers and routing state are request-local

## Safe errors

Public failures use a consistent shape:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Token rate limit exceeded."
  }
}
```

The public serializer prevents raw provider bodies, stack traces, API keys, SQLite errors, local file paths, internal URLs, and implementation details from being returned to clients.

## API

### `POST /v1/completions`

```http
x-api-key: tenant-key
Content-Type: application/json
```

```json
{
  "prompt": "hello",
  "tokenCount": 25
}
```

Example success:

```json
{
  "provider": "primary",
  "output": "hello",
  "usage": {
    "totalTokens": 1
  }
}
```

`tokenCount` is supplied by the caller for this assessment. In a production gateway, token counting should normally be performed server-side so clients cannot under-report usage.

## Validation

```bash
npm install
npm test
npm run typecheck
npm run build
```

The acceptance suite contains 45 tests covering:

- sliding-window capacity and eviction
- tenant isolation and SQLite persistence
- concurrent reservation safety
- primary success, 429 fallback, and timeout fallback
- timeout race behavior and late provider settlement
- standardized error sanitization
- end-to-end HTTP integration and concurrent requests

A successful run reports 45 passing tests and zero failures.

See [TEST_PLAN.md](./TEST_PLAN.md) for the full acceptance-test contract.

## Production considerations

The implementation deliberately matches the assessment scope. For a horizontally scaled production gateway, likely extensions include:

- server-side tokenization instead of trusting caller-supplied token counts
- a centralized rate-limit store such as Redis instead of per-instance SQLite
- periodic cleanup/retention policies for historical usage records
- production identity, secret management, observability, and provider integrations
