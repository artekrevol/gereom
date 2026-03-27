require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL. Copy .env.example to .env and set your connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

/** One statement per round-trip — Railway’s DB proxy rejects some multi-statement batches. */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist_signups (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS waitlist_signups_email_unique ON waitlist_signups (email)'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_events (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS site_events_action_idx ON site_events (action)'
  );
}

const app = express();
app.use(express.json({ limit: '32kb' }));

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
app.use(
  cors(
    corsOrigins && corsOrigins.length
      ? { origin: corsOrigins }
      : { origin: true }
  )
);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const SOURCE_SET = new Set(['hero', 'footer']);

app.post('/api/waitlist', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  let source = String(req.body?.source || 'unknown').toLowerCase();
  if (!SOURCE_SET.has(source)) source = 'unknown';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  try {
    const r = await pool.query(
      `INSERT INTO waitlist_signups (email, source) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, source]
    );
    const inserted = r.rowCount > 0;
    return res.json({ ok: true, duplicate: !inserted });
  } catch (e) {
    console.error('waitlist insert', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/event', async (req, res) => {
  const action = String(req.body?.action || '').slice(0, 120);
  if (!action) {
    return res.status(400).json({ ok: false, error: 'missing_action' });
  }
  let detail = req.body?.detail;
  if (detail !== undefined && detail !== null && typeof detail !== 'object') {
    detail = { value: detail };
  }

  try {
    await pool.query('INSERT INTO site_events (action, detail) VALUES ($1, $2::jsonb)', [
      action,
      JSON.stringify(detail && typeof detail === 'object' ? detail : {}),
    ]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('event insert', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ ok: true, db: true });
  } catch (e) {
    return res.status(503).json({ ok: false, db: false });
  }
});

app.use(express.static(path.join(__dirname)));

async function main() {
  try {
    await initDb();
    console.log('Database schema ready.');
  } catch (e) {
    console.error('initDb failed:', e && e.message ? e.message : e);
    throw e;
  }
  const host = '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`GereOM listening on ${host}:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
