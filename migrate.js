import { createPool, runMigrations } from './db.js';

const pool = createPool();
try {
  await runMigrations(pool);
  console.log('Migrations are up to date.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
