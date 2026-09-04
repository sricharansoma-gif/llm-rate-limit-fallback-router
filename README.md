# LLM Rate-Limit and Fallback Router

TypeScript/Express scaffold for a resilient LLM gateway. The intended gateway
enforces a persistent, per-tenant token sliding window and falls back from a
primary model provider on HTTP 429 or timeout.

The SQLite-backed rate limiter is implemented. Provider routing, fallback
timing, HTTP gateway routes, and complete error middleware remain intentionally
unimplemented. No real provider is called, and no API credentials are required.

Reservations use an atomic SQLite write transaction, an injectable clock, and
hashed tenant identifiers so raw API keys are not persisted. Zero-token
requests are accepted without creating a record. Records exactly 60 seconds old
are expired.

## Planned defaults

- Token capacity: 50,000 tokens per tenant API key
- Sliding window: 60,000 ms
- Primary provider timeout: 3,000 ms
- Persistence: on-disk SQLite

## Project layout

```text
src/
  app.ts
  server.ts
  config/
  db/
  errors/
  providers/
  rate-limit/
  router/
  types/
tests/
  errors/
  integration/
  rate-limit/
  router/
```

## Future setup

Dependencies have deliberately not been installed for this assessment step.
When implementation begins, copy `.env.example` to `.env`, install packages,
and use `npm test`, `npm run typecheck`, and `npm run build`.

See [TEST_PLAN.md](./TEST_PLAN.md) for the complete acceptance-test contract.
