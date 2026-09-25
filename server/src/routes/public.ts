import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { signAdminToken } from '../middleware/auth.js';
import { computeSlots } from '../services/slots.js';
import { cancelBooking, createBooking, getBookingDetail, rescheduleBooking } from '../services/booking.js';
import { submitReview } from '../services/reviews.js';

export const publicRouter = Router();

/** There is exactly one provider row (the doctor); resolve it, never hardcode an id. */
async function theProviderId(): Promise<number> {
  const { rows: [row] } = await pool.query('SELECT id FROM providers ORDER BY id LIMIT 1');
  if (!row) throw Object.assign(new Error('No doctor configured'), { status: 404 });
  return row.id;
}

// ---------------------------------------------------------------- auth
publicRouter.post('/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .parse(req.body);
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE email = lower($1)', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const claims = { sub: user.id, email: user.email, name: user.name };
  res.json({ token: signAdminToken(claims), user: claims });
}));

// -------------------------------------------------------------- the doctor
publicRouter.get('/provider', asyncHandler(async (_req, res) => {
  const id = await theProviderId();
  const { rows: [provider] } = await pool.query(
    `SELECT p.*,
            (SELECT round(avg(rating), 1) FROM reviews WHERE provider_id = p.id AND NOT hidden) AS avg_rating,
            (SELECT count(*) FROM reviews WHERE provider_id = p.id AND NOT hidden)              AS review_count
     FROM providers p WHERE p.id = $1`,
    [id]
  );
  if (!provider) return res.status(404).json({ error: 'No doctor configured' });
  const [services, schedules] = await Promise.all([
    pool.query('SELECT * FROM services WHERE provider_id = $1 AND active ORDER BY price_cents', [id]),
    pool.query('SELECT weekday, start_time, end_time FROM schedules WHERE provider_id = $1 ORDER BY weekday, start_time', [id]),
  ]);
  res.json({ ...provider, services: services.rows, schedules: schedules.rows });
}));

publicRouter.get('/provider/reviews', asyncHandler(async (_req, res) => {
  const id = await theProviderId();
  const { rows } = await pool.query(
    `SELECT r.rating, r.comment, r.created_at,
            split_part(c.name, ' ', 1) AS customer_name, s.name AS service_name
     FROM reviews r
     JOIN bookings b ON b.id = r.booking_id
     JOIN customers c ON c.id = r.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE r.provider_id = $1 AND NOT r.hidden
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [id]
  );
  res.json(rows);
}));

// ---------------------------------------------------------------- slots
publicRouter.get('/provider/slots', asyncHandler(async (req, res) => {
  const providerId = await theProviderId();
  const { serviceId, date, excludeBooking } = z.object({
    serviceId: z.coerce.number().int(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    excludeBooking: z.coerce.number().int().optional(), // reschedule: free the booking's own slot
  }).parse(req.query);
  const { slots } = await computeSlots(pool, providerId, serviceId, date, excludeBooking);
  res.json({ date, slots });
}));

// ---------------------------------------------------------------- bookings
const bookingSchema = z.object({
  serviceId: z.number().int(),
  start: z.string(),
  customer: z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    phone: z.string().max(30).optional(),
  }),
  notes: z.string().max(1000).optional(),
});

publicRouter.post('/bookings', asyncHandler(async (req, res) => {
  const input = bookingSchema.parse(req.body);
  const providerId = await theProviderId();
  const { booking } = await createBooking({ ...input, providerId });
  const detail = await getBookingDetail('b.id = $1', [booking.id]);
  res.status(201).json(detail);
}));

publicRouter.get('/bookings/lookup', asyncHandler(async (req, res) => {
  const { code, email } = z
    .object({ code: z.string().min(4), email: z.string().email() })
    .parse(req.query);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  res.json(detail);
}));

publicRouter.post('/bookings/:code/cancel', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  if (detail.status !== 'confirmed') {
    return res.status(400).json({ error: `This booking is already ${detail.status}` });
  }
  if (new Date(detail.starts_at) < new Date()) {
    return res.status(400).json({ error: 'Past bookings cannot be cancelled' });
  }
  await cancelBooking(detail.id, 'customer', 'Cancelled via manage page');
  res.json({ ...detail, status: 'cancelled' });
}));

publicRouter.post('/bookings/:code/review', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email, rating, comment } = z.object({
    email: z.string().email(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).default(''),
  }).parse(req.body);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  const review = await submitReview(detail, rating, comment);
  if (!review) return res.status(409).json({ error: 'This booking has already been reviewed' });
  res.status(201).json(review);
}));

publicRouter.post('/bookings/:code/reschedule', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email, start } = z.object({ email: z.string().email(), start: z.string() }).parse(req.body);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  await rescheduleBooking(detail.id, start, 'customer');
  res.json(await getBookingDetail('b.id = $1', [detail.id]));
}));
