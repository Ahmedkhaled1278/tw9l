'use strict';
const baseUrl = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
(async () => {
  const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== 'ok' || !['json', 'postgres'].includes(body.storage)) {
    console.error(`Health check failed (${response.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  const protectedResponse = await fetch(`${baseUrl}/api/conversations`, { signal: AbortSignal.timeout(5000) });
  if (protectedResponse.status !== 401) {
    console.error(`Expected unauthenticated /api/conversations to return 401, got ${protectedResponse.status}.`);
    process.exit(1);
  }
  console.log(`PASS: ${baseUrl} health=${body.status}, storage=${body.storage}; protected route rejects anonymous access.`);
})().catch(err => { console.error(`Smoke test failed: ${err.message}`); process.exit(1); });
