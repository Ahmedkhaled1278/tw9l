# Wasl Phase 21 — Persistent Profile Avatars

## Delivered
- Authenticated upload endpoint `POST /api/account/avatar` (multipart field `avatar`), remove endpoint `DELETE /api/account/avatar`, and authenticated read endpoint `GET /api/account/avatar/:userId`.
- Server-side upload limit 1 MiB, one file only, PNG/JPEG/WebP allowlist and signature checks independent of the browser-provided MIME type.
- Random UUID-based storage names under `UPLOAD_DIR/profile-avatars`, outside the static website root. Avatar files are not served by `express.static`; reads pass through authenticated API with `nosniff` and private cache headers.
- JSON and PostgreSQL repository methods persist avatar metadata; API responses expose an avatar URL but do not expose the internal storage filename or password hash.
- Other authenticated users can load avatars from direct-chat member metadata; frontend fetches image bytes with the session bearer token.
- Migration `migrations/106_phase21_profile_avatars.sql`; fresh schema files also include the columns.
- Added JSON repository lifecycle test, API contract/security tests, and HTTP integration scenarios for unauthenticated access, fake PNG rejection, upload/read/delete lifecycle.

## Local verification actually run
- `node --check server/index.js`: PASS.
- `node --check server/storage/json/index.js`: PASS.
- `node --check server/storage/pg/index.js`: PASS.
- `node --check website/app.js`: PASS.
- `node --check tests/api-integration.test.js`: PASS.
- `npm run check:syntax`: PASS.
- `npm run check:static`: PASS.
- `npm test`: 39 total, 36 passed, 0 failed, 3 skipped.
- ZIP integrity check: see delivery verification after archive creation.

## Skipped / not claimed
- The HTTP integration test (including the new avatar HTTP scenarios) is skipped locally because Node dependencies are not installed (`express`, `bcryptjs`, `jsonwebtoken`, `socket.io`, `multer`, etc.).
- PostgreSQL repository/concurrency tests are skipped because `TEST_DATABASE_URL` and a disposable PostgreSQL instance are unavailable. No live HTTP or PostgreSQL run is claimed. The GitHub Actions workflow includes Node dependency installation and a PostgreSQL 16 service to execute those tests in CI; CI has not been run from this local environment.

## Deployment notes
- Back up the current database and uploads before deployment. Existing PostgreSQL deployments must apply `migrations/106_phase21_profile_avatars.sql` before starting this version.
- Keep `UPLOAD_DIR` persistent. If running multiple server replicas, use shared persistent storage or object storage; local container disk alone will not synchronize avatar files across replicas.
- Upload limit is 1 MiB. This phase validates file signatures but does not perform full image re-encoding/resizing; a future hardening step could decode/re-encode images through a maintained image library.
