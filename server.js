const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3333);
const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const RESERVATION_MINUTES = Number(process.env.RESERVATION_MINUTES || 60);

if (!API_KEY) {
  console.error('Missing API_KEY environment variable.');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable.');
  process.exit(1);
}

const app = express();
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10)
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.header('X-API-Key') || req.header('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
});

function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  while (phone.startsWith('0')) phone = phone.slice(1);
  if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
  if (phone.length < 12 || phone.length > 15) return null;
  return phone;
}

function parseContactLines(text) {
  return String(text || '')
    .split(/\r?\n|;|,/)
    .map(line => line.trim())
    .filter(Boolean);
}

function extractPhones(text) {
  const candidates = parseContactLines(text);
  const phones = [];

  for (const candidate of candidates) {
    const direct = /[a-zA-Z]/.test(candidate) ? null : normalizePhone(candidate);
    if (direct) {
      phones.push({ raw: candidate, phone: direct });
      continue;
    }

    const matches = candidate.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}/g) || [];
    for (const match of matches) {
      const phone = normalizePhone(match);
      if (phone) phones.push({ raw: match, phone });
    }
  }

  return phones;
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      raw_phone TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reserved_by TEXT,
      reserved_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sends (
      id BIGSERIAL PRIMARY KEY,
      contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
      batch_id TEXT,
      worker_id TEXT,
      session_id INTEGER,
      sender_phone TEXT,
      destination_phone TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      details TEXT,
      message_preview TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_status_id ON contacts(status, id);
    CREATE INDEX IF NOT EXISTS idx_contacts_reserved_until ON contacts(reserved_until);
    CREATE INDEX IF NOT EXISTS idx_sends_created_at ON sends(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sends_destination ON sends(destination_phone);
    CREATE INDEX IF NOT EXISTS idx_sends_worker_session ON sends(worker_id, session_id);
  `);
}

async function getSummary() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'reserved')::int AS reserved,
      COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      (
        SELECT COUNT(DISTINCT destination_phone)::int
        FROM sends
        WHERE status = 'SENT'
          AND created_at::date = CURRENT_DATE
      ) AS sent_today
    FROM contacts
  `);

  return rows[0];
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'wa-central-api' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/contacts/summary', async (req, res) => {
  res.json({ ok: true, summary: await getSummary() });
});

app.post('/contacts/import', async (req, res) => {
  const { contacts, source = 'api' } = req.body;
  if (!contacts?.trim()) return res.status(400).json({ ok: false, error: 'contacts is required' });

  const lines = parseContactLines(contacts);
  const phones = extractPhones(contacts);
  const seen = new Set();
  const summary = {
    totalLines: lines.length,
    valid: 0,
    imported: 0,
    duplicatesInList: 0,
    alreadyExisting: 0,
    invalid: 0
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of phones) {
      if (seen.has(item.phone)) {
        summary.duplicatesInList++;
        continue;
      }
      seen.add(item.phone);
      summary.valid++;

      const result = await client.query(`
        INSERT INTO contacts (phone, raw_phone, source)
        VALUES ($1, $2, $3)
        ON CONFLICT (phone) DO NOTHING
      `, [item.phone, item.raw, source]);

      if (result.rowCount > 0) summary.imported++;
      else summary.alreadyExisting++;
    }
    summary.invalid = Math.max(lines.length - phones.length, 0);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.json({ ok: true, result: { ...summary, database: await getSummary() } });
});

app.post('/contacts/reserve', async (req, res) => {
  const quantity = Math.min(Math.max(Number(req.body.quantity || 100), 1), 5000);
  const workerId = String(req.body.workerId || 'worker');
  const reservationMinutes = Math.min(Math.max(Number(req.body.reservationMinutes || RESERVATION_MINUTES), 5), 1440);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      WITH picked AS (
        SELECT id
        FROM contacts
        WHERE status = 'pending'
           OR (status = 'reserved' AND reserved_until < now())
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE contacts c
      SET status = 'reserved',
          reserved_by = $2,
          reserved_until = now() + ($3::int * interval '1 minute'),
          updated_at = now()
      FROM picked
      WHERE c.id = picked.id
      RETURNING c.id, c.phone
    `, [quantity, workerId, reservationMinutes]);
    await client.query('COMMIT');
    res.json({ ok: true, contacts: rows, count: rows.length });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

app.post('/contacts/release', async (req, res) => {
  const workerId = String(req.body.workerId || '');
  if (!workerId) return res.status(400).json({ ok: false, error: 'workerId is required' });

  const result = await pool.query(`
    UPDATE contacts
    SET status = 'pending',
        reserved_by = NULL,
        reserved_until = NULL,
        updated_at = now()
    WHERE status = 'reserved'
      AND reserved_by = $1
  `, [workerId]);

  res.json({ ok: true, released: result.rowCount });
});

app.post('/contacts/mark-sent', async (req, res) => {
  const { contacts, details = 'Marcado manualmente' } = req.body;
  if (!contacts?.trim()) return res.status(400).json({ ok: false, error: 'contacts is required' });

  const phones = extractPhones(contacts);
  const seen = new Set();
  let marked = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of phones) {
      if (seen.has(item.phone)) continue;
      seen.add(item.phone);
      const { rows } = await client.query(`
        INSERT INTO contacts (phone, raw_phone, status)
        VALUES ($1, $2, 'sent')
        ON CONFLICT (phone) DO UPDATE
          SET status = 'sent',
              reserved_by = NULL,
              reserved_until = NULL,
              updated_at = now()
        RETURNING id
      `, [item.phone, item.raw]);

      await client.query(`
        INSERT INTO sends (contact_id, destination_phone, status, reason, details)
        VALUES ($1, $2, 'SENT', 'MANUAL', $3)
      `, [rows[0].id, item.phone, details]);
      marked++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.json({ ok: true, result: { marked, database: await getSummary() } });
});

app.post('/sends', async (req, res) => {
  const {
    contactId,
    batchId,
    workerId,
    sessionId,
    senderPhone,
    destinationPhone,
    status,
    reason = '',
    details = '',
    messagePreview = ''
  } = req.body;

  const normalizedDestination = normalizePhone(destinationPhone);
  if (!normalizedDestination) return res.status(400).json({ ok: false, error: 'destinationPhone invalid' });
  if (!['SENT', 'FAILED'].includes(status)) return res.status(400).json({ ok: false, error: 'status must be SENT or FAILED' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const send = await client.query(`
      INSERT INTO sends (
        contact_id, batch_id, worker_id, session_id, sender_phone, destination_phone,
        status, reason, details, message_preview
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      contactId || null,
      batchId || null,
      workerId || null,
      sessionId ?? null,
      senderPhone || null,
      normalizedDestination,
      status,
      reason,
      details,
      messagePreview
    ]);

    await client.query(`
      UPDATE contacts
      SET status = $2,
          reserved_by = NULL,
          reserved_until = NULL,
          updated_at = now()
      WHERE id = $1 OR phone = $3
    `, [contactId || null, status === 'SENT' ? 'sent' : 'failed', normalizedDestination]);

    await client.query('COMMIT');
    res.json({ ok: true, send: send.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

app.get('/report', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 1000), 1), 5000);
  const { rows } = await pool.query(`
    SELECT
      created_at AS "timestamp",
      batch_id AS "batchId",
      worker_id AS "workerId",
      session_id AS "sessionId",
      sender_phone AS "senderPhone",
      destination_phone AS phone,
      status,
      reason,
      details,
      message_preview AS preview
    FROM sends
    ORDER BY id DESC
    LIMIT $1
  `, [limit]);

  res.json({ ok: true, report: rows });
});

app.get('/report/csv', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 5000), 1), 20000);
  const { rows } = await pool.query(`
    SELECT created_at, batch_id, worker_id, session_id, sender_phone, destination_phone,
           status, reason, details, message_preview
    FROM sends
    ORDER BY id DESC
    LIMIT $1
  `, [limit]);

  const esc = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ['timestamp', 'batchId', 'workerId', 'sessionId', 'senderPhone', 'phone', 'status', 'reason', 'details', 'preview'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      esc(row.created_at),
      esc(row.batch_id),
      esc(row.worker_id),
      esc(row.session_id),
      esc(row.sender_phone),
      esc(row.destination_phone),
      esc(row.status),
      esc(row.reason),
      esc(row.details),
      esc(row.message_preview)
    ].join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="wa-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || 'Internal error' });
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WA Central API listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
