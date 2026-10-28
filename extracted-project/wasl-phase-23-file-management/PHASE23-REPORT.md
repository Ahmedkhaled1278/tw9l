# Wasl — Phase 23: File management

## Added
- Authenticated endpoint to list the signed-in user's uploaded attachments: `GET /api/account/storage/files`.
- Owner-only endpoint to delete an uploaded attachment: `DELETE /api/account/storage/files/:attachmentId`.
- Storage settings UI now lists uploaded files with size/date and offers an explicit confirmation before deletion.
- Deletion updates the repository first: message is soft-deleted and attachment becomes `orphaned`, then the server attempts to unlink the physical file.
- JSON and PostgreSQL repository implementations. Legacy JSON attachment records without `status`/`messageId` are normalized and linked to their message on store initialization.
- Added repository tests for owner checks, legacy JSON compatibility, message soft-deletion, and quota accounting; added HTTP integration assertions for authenticated listing.

## Security and recovery notes
- Unauthenticated file listing is rejected by the shared `auth` middleware.
- Unknown IDs and attachments owned by another user return the same not-found result.
- File unlink is restricted to a resolved path directly inside `UPLOAD_DIR`.
- If filesystem unlink fails after the repository update, the file record is hidden and excluded from quota; a conservative scheduled orphan-file cleanup task remains future work.
- PostgreSQL integration must be verified in GitHub Actions; it was not run against a live PostgreSQL database in this local environment.

## Actual local verification
- `npm run check:syntax`: passed.
- `npm run check:static`: passed.
- `npm test`: 42 total, 39 passed, 0 failed, 3 skipped.
- `sh -n scripts/backup-postgres.sh scripts/restore-postgres.sh`: passed.
- HTTP integration test skipped because runtime dependencies are not installed in this environment.
- Two PostgreSQL tests skipped because `TEST_DATABASE_URL` is not configured.

## Version
- Package version: `0.21.0`.
