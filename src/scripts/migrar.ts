/** Aplica db/migrations/*.sql em ordem, uma vez cada (registro em app.schema_migrations). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../lib/db.js';

const dir = join(process.cwd(), 'db', 'migrations');
const c = await pool.connect();
try {
  await c.query(`CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE IF NOT EXISTS app.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await c.query(`SELECT name FROM app.schema_migrations`)).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await c.query('BEGIN');
    await c.query(readFileSync(join(dir, f), 'utf8'));
    await c.query(`INSERT INTO app.schema_migrations (name) VALUES ($1)`, [f]);
    await c.query('COMMIT');
    console.log(`aplicada: ${f}`);
  }
  console.log('migracoes em dia');
} catch (e) {
  await c.query('ROLLBACK').catch(() => undefined);
  console.error(e);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
