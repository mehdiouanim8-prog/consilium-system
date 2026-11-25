import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Return BIGINT (COUNT(*), window_start) as JS numbers. All values here are far below 2^53.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

function sslConfig(connectionString) {
  const mode = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'false' || mode === 'disable' || mode === '0') return false;
  if (mode === 'true' || mode === 'require' || mode === '1') return { rejectUnauthorized: false };
  // Railway's private network (*.railway.internal) is not TLS; its public TCP proxy is.
  try {
    const host = new URL(connectionString).hostname;
    if (host.endsWith('.proxy.rlwy.net') || host.endsWith('.rlwy.net')) return { rejectUnauthorized: false };
  } catch (_error) { /* fall through */ }
  return false;
}

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Add a PostgreSQL database to the Railway project and reference its DATABASE_URL.');
  }
  const pool = new pg.Pool({
    connectionString,
    ssl: sslConfig(connectionString),
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  pool.on('error', (error) => console.error('Postgres pool error:', error.code || error.name));
  return pool;
}

// Converts "?" placeholders to $1, $2, ... (no query in this project uses a literal "?").
function toPg(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class Statement {
  constructor(pool, sql) {
    this.pool = pool;
    this.sql = toPg(sql);
    this.params = [];
  }

  bind(...params) {
    this.params = params.map((value) => (value === undefined ? null : value));
    return this;
  }

  async first() {
    const result = await this.pool.query(this.sql, this.params);
    return result.rows[0] || null;
  }

  async all() {
    const result = await this.pool.query(this.sql, this.params);
    return { results: result.rows, meta: { changes: result.rowCount } };
  }

  async run() {
    const result = await this.pool.query(this.sql, this.params);
    return { meta: { changes: result.rowCount } };
  }
}

// D1-compatible facade so the application logic is unchanged.
export function wrapPool(pool) {
  return { prepare: (sql) => new Statement(pool, sql), pool };
}

export async function runMigrations(pool, log = console.log) {
  const client = await pool.connect();
  try {
    // Serialise migrations if several instances boot at once.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['consilium-migrations']);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`Applying migration ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['consilium-migrations']).catch(() => {});
    client.release();
  }
}
