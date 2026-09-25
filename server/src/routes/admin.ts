import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { cancelBooking, getBookingDetail } from '../services/booking.js';
import { sanitizeRichText } from '../services/richText.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/** There is exactly one provider row (the doctor); resolve it, never hardcode an id. */
async function theProviderId(): Promise<number> {
  const { rows: [row] } = await pool.query('SELECT id FROM providers ORDER BY id LIMIT 1');
  if (!row) throw Object.assign(new Error('No doctor configured'), { status: 404 });
  return row.id;
}

// ---------------------------------------------------------------- dashboard
adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  const { rows: [stats] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM bookings WHERE starts_at::date = current_date AND status = 'confirmed')                    AS today_confirmed,
      (SELECT count(*) FROM bookings WHERE starts_at >= now() AND starts_at < now() + interval '7 days' AND status = 'confirmed') AS next7_confirmed,
      (SELECT count(*) FROM bookings WHERE status = 'cancelled' AND created_at >= now() - interval '30 days')          AS cancelled_30d,
      (SELECT count(*) FROM bookings WHERE created_at >= now() - interval '30 days')                                   AS created_30d
  `);
  res.json(stats);
}));

// ---------------------------------------------------------------- bookings
const bookingFilterSchema = z.object({
  status: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().optional(),
});

/** Shared by the list endpoint and the CSV export so they always agree. */
function buildBookingFilter(q: z.infer<typeof bookingFilterSchema>) {
  const params: unknown[] = [];
  const where: string[] = ['true'];
  if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
  if (q.date) { params.push(q.date); where.push(`b.starts_at::date = $${params.length}::date`); }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(b.code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  return { params, where: where.join(' AND ') };
}

const BOOKING_LIST_SELECT = `
  SELECT b.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         s.name AS service_name
  FROM bookings b
  JOIN customers c ON c.id = b.customer_id
  JOIN services s ON s.id = b.service_id`;

adminRouter.get('/bookings', asyncHandler(async (req, res) => {
  const q = bookingFilterSchema.extend({
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(req.query);
  const { params, where } = buildBookingFilter(q);
  params.push(q.limit);
  const { rows } = await pool.query(
    `${BOOKING_LIST_SELECT} WHERE ${where} ORDER BY b.starts_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

/** CSV cell: quote when needed, double inner quotes, defuse formula injection. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

adminRouter.get('/bookings.csv', asyncHandler(async (req, res) => {
  const q = bookingFilterSchema.parse(req.query);
  const { params, where } = buildBookingFilter(q);
  const { rows } = await pool.query(
    `${BOOKING_LIST_SELECT} WHERE ${where} ORDER BY b.starts_at DESC LIMIT 10000`,
    params
  );
  const header = ['code', 'status', 'service', 'customer_name', 'customer_email',
    'customer_phone', 'starts_at', 'ends_at', 'price_pkr', 'created_at', 'notes'];
  const lines = [header.join(',')];
  for (const b of rows) {
    lines.push([
      b.code, b.status, b.service_name, b.customer_name, b.customer_email,
      b.customer_phone,
      new Date(b.starts_at).toISOString(), new Date(b.ends_at).toISOString(),
      (b.price_cents / 100).toFixed(2),
      new Date(b.created_at).toISOString(), b.notes,
    ].map(csvCell).join(','));
  }
  // BOM so Excel opens UTF-8 (emoji, non-ASCII names) correctly; CRLF per RFC 4180
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

adminRouter.get('/bookings/:id/events', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows } = await pool.query(
    'SELECT * FROM booking_events WHERE booking_id = $1 ORDER BY created_at', [id]
  );
  res.json(rows);
}));

const TRANSITIONS: Record<string, string[]> = {
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

adminRouter.patch('/bookings/:id/status', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { status } = z.object({ status: z.enum(['completed', 'cancelled', 'no_show']) }).parse(req.body);

  const detail = await getBookingDetail('b.id = $1', [id]);
  if (!detail) return res.status(404).json({ error: 'Booking not found' });
  if (!TRANSITIONS[detail.status]?.includes(status)) {
    return res.status(400).json({ error: `Cannot move a ${detail.status} booking to ${status}` });
  }
  if (status === 'cancelled') {
    await cancelBooking(id, `admin:${req.admin!.email}`);
  } else {
    await pool.query(`UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
    await pool.query(
      `INSERT INTO booking_events (booking_id, event, actor) VALUES ($1, $2, $3)`,
      [id, status, `admin:${req.admin!.email}`]
    );
  }
  res.json({ ...detail, status });
}));

// ------------------------------------------------------------------- reviews
adminRouter.get('/reviews', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, b.code AS booking_code, c.name AS customer_name, c.email AS customer_email,
            s.name AS service_name
     FROM reviews r
     JOIN bookings b ON b.id = r.booking_id
     JOIN customers c ON c.id = r.customer_id
     JOIN services s ON s.id = b.service_id
     ORDER BY r.created_at DESC
     LIMIT 200`
  );
  res.json(rows);
}));

adminRouter.patch('/reviews/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
  const { rows: [row] } = await pool.query(
    'UPDATE reviews SET hidden = $2 WHERE id = $1 RETURNING *', [id, hidden]
  );
  if (!row) return res.status(404).json({ error: 'Review not found' });
  await pool.query(
    `INSERT INTO booking_events (booking_id, event, actor) VALUES ($1, $2, $3)`,
    [row.booking_id, hidden ? 'review_hidden' : 'review_unhidden', `admin:${req.admin!.email}`]
  );
  res.json(row);
}));

// ------------------------------------------------------- day view (timeline)
adminRouter.get('/day', asyncHandler(async (req, res) => {
  const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT b.id, b.code, b.starts_at, b.ends_at, b.status,
            c.name AS customer_name, s.name AS service_name
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at::date = $1::date AND b.status IN ('confirmed','completed')
     ORDER BY b.starts_at`,
    [date]
  );
  res.json(rows);
}));

// ------------------------------------------------------- week view (calendar)
adminRouter.get('/week', asyncHandler(async (req, res) => {
  const { start } = z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT b.id, b.code, b.starts_at, b.ends_at, b.status,
            c.name AS customer_name, s.name AS service_name, s.duration_min
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at >= $1::date AND b.starts_at < $1::date + interval '7 days'
       AND b.status IN ('confirmed','completed')
     ORDER BY b.starts_at`,
    [start]
  );
  res.json(rows);
}));

// ----------------------------------------------------------------- provider
const providerSchema = z.object({
  name: z.string().min(2).max(120),
  title: z.string().max(120).default(''),
  bio: z.string().max(8000).default(''),
  emoji: z.string().max(8).default('📅'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  slot_step_min: z.number().int().min(5).max(120).default(15),
  min_lead_min: z.number().int().min(0).max(10080).default(60),
  booking_horizon_days: z.number().int().min(1).max(365).default(30),
  reschedule_cutoff_min: z.number().int().min(0).max(10080).default(120),
  active: z.boolean().default(true),
});

adminRouter.get('/provider', asyncHandler(async (_req, res) => {
  const id = await theProviderId();
  const { rows: [provider] } = await pool.query('SELECT * FROM providers WHERE id = $1', [id]);
  const [services, schedules, breaks, timeOff] = await Promise.all([
    pool.query('SELECT * FROM services WHERE provider_id = $1 ORDER BY active DESC, name', [id]),
    pool.query('SELECT * FROM schedules WHERE provider_id = $1 ORDER BY weekday, start_time', [id]),
    pool.query('SELECT * FROM breaks WHERE provider_id = $1 ORDER BY weekday, start_time', [id]),
    pool.query('SELECT * FROM time_off WHERE provider_id = $1 AND ends_at > now() ORDER BY starts_at', [id]),
  ]);
  res.json({
    ...provider,
    services: services.rows,
    schedules: schedules.rows,
    breaks: breaks.rows,
    time_off: timeOff.rows,
  });
}));

adminRouter.put('/provider', asyncHandler(async (req, res) => {
  const id = await theProviderId();
  const p = providerSchema.parse(req.body);
  const bio = sanitizeRichText(p.bio);
  const { rows: [row] } = await pool.query(
    `UPDATE providers SET name=$2, title=$3, bio=$4, emoji=$5, color=$6,
       slot_step_min=$7, min_lead_min=$8, booking_horizon_days=$9, reschedule_cutoff_min=$10, active=$11
     WHERE id = $1 RETURNING *`,
    [id, p.name, p.title, bio, p.emoji, p.color, p.slot_step_min, p.min_lead_min, p.booking_horizon_days, p.reschedule_cutoff_min, p.active]
  );
  res.json(row);
}));

// Replace the full weekly schedule + breaks atomically
adminRouter.put('/provider/schedule', asyncHandler(async (req, res) => {
  const id = await theProviderId();
  const timeRe = /^\d{2}:\d{2}(:\d{2})?$/;
  const body = z.object({
    schedules: z.array(z.object({
      weekday: z.number().int().min(0).max(6),
      start_time: z.string().regex(timeRe),
      end_time: z.string().regex(timeRe),
    })),
    breaks: z.array(z.object({
      weekday: z.number().int().min(0).max(6),
      start_time: z.string().regex(timeRe),
      end_time: z.string().regex(timeRe),
      label: z.string().max(80).default('Break'),
    })),
  }).parse(req.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM schedules WHERE provider_id = $1', [id]);
    await client.query('DELETE FROM breaks WHERE provider_id = $1', [id]);
    for (const s of body.schedules) {
      await client.query(
        'INSERT INTO schedules (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [id, s.weekday, s.start_time, s.end_time]
      );
    }
    for (const b of body.breaks) {
      await client.query(
        'INSERT INTO breaks (provider_id, weekday, start_time, end_time, label) VALUES ($1,$2,$3,$4,$5)',
        [id, b.weekday, b.start_time, b.end_time, b.label]
      );
    }
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') {
      return res.status(400).json({ error: 'Working windows on the same day must not overlap' });
    }
    if (err.code === '23514') {
      return res.status(400).json({ error: 'Start time must be before end time' });
    }
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- time off
adminRouter.post('/provider/time-off', asyncHandler(async (req, res) => {
  const id = await theProviderId();
  const body = z.object({
    starts_at: z.string(),
    ends_at: z.string(),
    reason: z.string().max(200).default(''),
  }).parse(req.body);
  if (new Date(body.starts_at) >= new Date(body.ends_at)) {
    return res.status(400).json({ error: 'Start must be before end' });
  }
  const { rows: [row] } = await pool.query(
    'INSERT INTO time_off (provider_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING *',
    [id, body.starts_at, body.ends_at, body.reason]
  );
  res.status(201).json(row);
}));

adminRouter.delete('/time-off/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  await pool.query('DELETE FROM time_off WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- services
const serviceSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(4000).default(''),
  duration_min: z.number().int().min(5).max(480),
  buffer_min: z.number().int().min(0).max(120).default(0),
  price_cents: z.number().int().min(0),
  active: z.boolean().default(true),
});

adminRouter.post('/provider/services', asyncHandler(async (req, res) => {
  const providerId = await theProviderId();
  const s = serviceSchema.parse(req.body);
  const description = sanitizeRichText(s.description);
  const { rows: [row] } = await pool.query(
    `INSERT INTO services (provider_id, name, description, duration_min, buffer_min, price_cents, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [providerId, s.name, description, s.duration_min, s.buffer_min, s.price_cents, s.active]
  );
  res.status(201).json(row);
}));

adminRouter.put('/services/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const s = serviceSchema.parse(req.body);
  const description = sanitizeRichText(s.description);
  const { rows: [row] } = await pool.query(
    `UPDATE services SET name=$2, description=$3, duration_min=$4, buffer_min=$5, price_cents=$6, active=$7
     WHERE id = $1 RETURNING *`,
    [id, s.name, description, s.duration_min, s.buffer_min, s.price_cents, s.active]
  );
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
}));
