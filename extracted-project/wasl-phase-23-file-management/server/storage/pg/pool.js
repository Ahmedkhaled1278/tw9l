'use strict';
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL storage.');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Math.max(1, Math.min(30, Number(process.env.PG_POOL_MAX || 10))),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
});
pool.on('error', err => console.error('[pg] idle client error:', err.message));

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('[pg] rollback failed:', rollbackError.message);
    }
    throw err;
  } finally {
    client.release();
  }
}
module.exports = { pool, withTransaction };
