# Wasl Phase 19 — Website UI and Settings Center

## Changes
- Replaced the account-settings prompt menu with a responsive settings dialog and navigation tabs.
- Added general preferences: dark theme, compact conversation list, Enter-to-send preference, optional incoming-message sound, and desktop notifications gated by browser support/permission.
- Added account privacy controls for last-seen visibility, online status visibility, and server-managed in-app notifications.
- Added notification list, mark-one-read, and mark-all-read controls.
- Added session inventory, revoke-another-session, refresh, and revoke-other-sessions controls.
- Added an About panel, keyboard focus styling, mobile layout, and reduced-motion support.
- General UI preferences are stored locally in localStorage; privacy, notifications, and sessions use authenticated API endpoints.
- Version bumped to 0.17.0.

## Commands actually run
- `node --check website/app.js` — PASS
- `node --check server/index.js` — PASS
- `npm run check:syntax` — PASS
- `npm run check:static` — PASS (required files, unique HTML IDs, JavaScript DOM references, CSS brace balance, and JS syntax)
- `npm test` — 35 tests total, 32 passed, 0 failed, 3 skipped
- ZIP integrity check — recorded after archive creation

## Skipped tests / limitations
- HTTP integration test skipped because runtime dependencies are not installed in this local environment.
- Two PostgreSQL integration/concurrency tests skipped because `TEST_DATABASE_URL` is not configured with a disposable migrated database.
- No real browser automation or visual cross-device test was available in this run; the UI was verified by syntax and static consistency checks only.
- Desktop notifications require browser support and user permission, and typically HTTPS or localhost. The optional sound may be blocked by browser autoplay rules until user interaction.
