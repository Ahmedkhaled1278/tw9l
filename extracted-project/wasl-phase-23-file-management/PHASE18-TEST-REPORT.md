# Wasl Phase 18 — Test and Verification Report

## Implemented

- Split GitHub Actions into static/JSON-backed checks and a PostgreSQL integration job using PostgreSQL 16.
- CI now applies `migrations/001_init.sql`, checks required tables/indexes, runs the full Node test suite, runs the HTTP integration test against JSON storage, and then runs that HTTP integration test against PostgreSQL storage.
- Expanded HTTP integration coverage for Helmet security headers, rejected cross-origin requests, authentication requirements, invalid registration/password input, session ownership, privacy validation, message-length validation, group membership, and a bounded 25-message request burst.
- Added PostgreSQL repository integration coverage for direct conversation membership, message edit ownership, read receipts, notification privacy and ownership, session revocation ownership, soft deletion, and bounded pagination over a 501-message history.
- Added randomized test emails and cleanup for the HTTP integration test so repeated runs do not collide with previous test users.
- Updated package version to `0.16.0` and documented test commands.

## Checks actually run in the current build environment

Environment: Node.js `v22.16.0`, npm `10.9.2`.

| Check | Result | Details |
|---|---|---|
| `npm test` | PASS with skips | 35 tests discovered: 32 passed, 0 failed, 3 skipped |
| `npm run check:syntax` | PASS | All JavaScript files in server/scripts/tests passed `node --check` |
| `npm run check:static` | PASS | Required files, HTML IDs, JS DOM references, CSS brace balance, JS syntax |
| PostgreSQL-backed repository tests | NOT RUN locally | `TEST_DATABASE_URL` and a PostgreSQL service are not available here |
| HTTP integration tests | NOT RUN locally | Runtime dependencies were unavailable; these tests are configured to run in CI after `npm install` |
| `npm install --no-audit --no-fund` | BLOCKED | Timed out in this environment; no dependency installation was confirmed |
| Production Docker image | NOT RUN locally | Docker is unavailable in this environment; CI is configured to build it |

The three skips in the local `npm test` run were the HTTP integration test and the two PostgreSQL integration/concurrency tests. Therefore, local results do **not** prove HTTP or PostgreSQL integration passed. Those tests are configured to run on GitHub Actions with dependencies and a real PostgreSQL 16 service; their results will only exist after that workflow is run in GitHub.

## Safe usage

Use a disposable test database only. Do not set `TEST_DATABASE_URL` or `DATABASE_URL` to production credentials. The PostgreSQL workflow uses a temporary CI service database. The API integration test creates unique test users and removes those users after the server process is stopped.
