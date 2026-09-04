# Test Plan

This document is the acceptance-test contract for the LLM gateway. The matching
Vitest suites currently contain `test.todo` placeholders; business logic is not
implemented in this scaffold.

Tests will use fake providers, temporary on-disk SQLite databases, controllable
clocks, and fake timers. They must never call a real LLM provider or use real
credentials.

## RATE LIMITER TESTS

1. Request below the 50,000 token/minute limit is accepted.
2. Request that exactly reaches 50,000 tokens is accepted.
3. Request that would exceed 50,000 tokens is rejected.
4. Rate limits are isolated by tenant/API key.
5. Usage from one tenant does not affect another tenant.
6. Expired usage older than 60 seconds is evicted.
7. Boundary behavior at approximately 60 seconds is correct.
8. Multiple usage records inside the window are summed correctly.
9. Token usage is persisted in SQLite.
10. Rate limiter state survives a new database connection/process-style recreation.
11. Concurrent requests cannot both bypass the token limit.
12. Failed or rejected reservations do not corrupt usage state.
13. Invalid/negative token counts are rejected.
14. Zero-token behavior is explicitly defined and tested.
15. SQLite transaction failures produce a safe gateway error.

## FALLBACK ROUTER TESTS

16. Successful primary response is returned without calling fallback.
17. Primary HTTP 429 causes fallback.
18. Primary timeout after 3000ms causes fallback.
19. A primary non-429 4xx error does not incorrectly trigger fallback unless explicitly designed otherwise.
20. A primary 5xx error behavior is explicitly defined and tested.
21. Fallback success is returned correctly.
22. Fallback failure returns a standardized gateway error.
23. Primary 429 followed by fallback failure is handled safely.
24. Primary timeout followed by fallback failure is handled safely.
25. Fallback is called at most once.
26. A timed-out primary request cannot later overwrite the fallback response.
27. Race condition where primary completes near the 3000ms boundary is deterministic.
28. Timeout timer/resources are cleaned up after primary succeeds.
29. Concurrent gateway requests do not share provider state accidentally.

## ERROR SANITIZATION TESTS

30. Error responses use one standardized JSON structure.
31. Raw upstream stack traces are never exposed.
32. Provider response bodies are not leaked.
33. API keys/secrets are not leaked.
34. Internal SQLite errors are not exposed.
35. Internal file paths are not exposed.
36. Internal provider URLs are not exposed.
37. Unknown unexpected exceptions become a generic safe gateway error.
38. Appropriate HTTP status codes are returned.

## INTEGRATION TESTS

39. Allowed request -> rate limiter -> primary -> success.
40. Rate-limited request stops before provider invocation.
41. Allowed request -> primary 429 -> fallback -> success.
42. Allowed request -> primary timeout -> fallback -> success.
43. Allowed request -> primary failure/fallback failure -> sanitized error.
44. Two simultaneous requests near the token limit cannot exceed the configured capacity.
45. Requests from two different tenants execute independently.

## Locked rate-limiter decisions

- Zero-token reservations are accepted and create no usage record (case 14).
- Define whether primary HTTP 5xx responses trigger fallback (case 20).
- Active records satisfy `timestamp > now - 60,000`; a record exactly at the
  cutoff is expired (case 7).
- SQLite failures at the rate-limiter boundary become a generic `INTERNAL_ERROR`
  with HTTP status 500 and no internal details (case 15).
- Define deterministic timeout precedence when completion and the 3,000 ms timer
  become runnable together (case 27).

## Implementation-phase testing notes

- Use fresh temporary database files per test and close every connection.
- Reopen the same database file for persistence/recreation coverage.
- Start competing reservations together and assert committed aggregate usage
  never exceeds capacity.
- Use deferred fake-provider promises and fake timers for timeout races; assert
  late primary settlement has no observable effect and timers are cleared.
- Seed errors with stack traces, API keys, provider bodies, SQLite paths, and
  provider URLs, then assert none appear anywhere in serialized responses.
