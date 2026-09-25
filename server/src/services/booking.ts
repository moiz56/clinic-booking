import { pool } from '../db/pool.js';
import { computeSlots } from './slots.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const genCode = () =>
  'BK-' + Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

export class BookingConflictError extends Error {
  status = 409;
  constructor(msg = 'That slot was just taken. Please pick another one.') {
    super(msg);
  }
}

export interface CreateBookingInput {
  providerId: number;
  serviceId: number;
  start: string; // ISO — must match a generated slot exactly
  customer: { name: string; email: string; phone?: string };
  notes?: string;
}

/**
 * Creates a booking with three layers of conflict protection:
 *
 *  1. pg_advisory_xact_lock(provider_id) — serialises concurrent booking
 *     attempts for the SAME provider.
 *  2. Slot re-validation inside the transaction — the requested start time
 *     must still be one of the slots the engine would offer right now. This
 *     also enforces schedule alignment, lead time, breaks and buffers, so a
 *     hand-crafted API call can't book 03:00 on a Sunday.
 *  3. The bookings_no_overlap EXCLUSION constraint — if anything slips
 *     through (or someone inserts via SQL), Postgres itself rejects the
 *     overlapping row with error 23P01.
 */
export async function createBooking(input: CreateBookingInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [42, input.providerId]);

    const requested = new Date(input.start);
    if (isNaN(requested.getTime())) {
      throw Object.assign(new Error('Invalid start time'), { status: 400 });
    }
    const dateStr = `${requested.getFullYear()}-${String(requested.getMonth() + 1).padStart(2, '0')}-${String(requested.getDate()).padStart(2, '0')}`;

    const { slots, service, provider } = await computeSlots(
      client, input.providerId, input.serviceId, dateStr
    );
    const slot = slots.find((s) => new Date(s.start).getTime() === requested.getTime());
    if (!slot) throw new BookingConflictError('That slot is no longer available.');

    // upsert customer by email — guest-only, always reflects the latest booking
    const { rows: [customer] } = await client.query(
      `INSERT INTO customers (name, email, phone)
       VALUES ($1, lower($2), $3)
       ON CONFLICT (email) DO UPDATE SET
         name  = EXCLUDED.name,
         phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE customers.phone END
       RETURNING *`,
      [input.customer.name.trim(), input.customer.email.trim(), input.customer.phone?.trim() ?? '']
    );

    const { rows: [booking] } = await client.query(
      `INSERT INTO bookings (code, provider_id, service_id, customer_id, starts_at, ends_at,
                             price_cents, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed',$8) RETURNING *`,
      [genCode(), input.providerId, input.serviceId, customer.id, slot.start, slot.end,
       service.price_cents, input.notes?.trim() ?? '']
    );

    await client.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1,'created','customer',$2)`,
      [booking.id, `Booked ${service.name} via web`]
    );

    await client.query('COMMIT');
    return { booking, customer, service, provider };
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') throw new BookingConflictError(); // exclusion_violation
    if (err.code === '23505' && err.constraint === 'bookings_code_key') {
      // astronomically unlikely code collision — caller can simply retry
      throw new BookingConflictError('Please retry your booking.');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move a confirmed booking to a new slot — same provider, same service, same
 * price snapshot. Concurrency-safe the same way createBooking is: advisory
 * lock first (identical lock order, so create/reschedule serialize), slot
 * re-validation with the booking's own slot excluded, and the GiST exclusion
 * constraint as the last line of defense (an UPDATE is only checked against
 * OTHER rows, so shifting within the own slot's window is fine).
 */
export async function rescheduleBooking(bookingId: number, newStart: string, actor: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [pre] } = await client.query('SELECT provider_id FROM bookings WHERE id = $1', [bookingId]);
    if (!pre) throw Object.assign(new Error('Booking not found'), { status: 404 });
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [42, pre.provider_id]);

    const { rows: [booking] } = await client.query(
      `SELECT b.*, p.reschedule_cutoff_min
       FROM bookings b
       JOIN providers p ON p.id = b.provider_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId]
    );
    if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
    if (booking.status !== 'confirmed') {
      throw Object.assign(new Error(`A ${booking.status} booking cannot be rescheduled`), { status: 400 });
    }
    const now = new Date();
    const currentStart = new Date(booking.starts_at);
    if (currentStart <= now) {
      throw Object.assign(new Error('Past bookings cannot be rescheduled'), { status: 400 });
    }
    if (now.getTime() > currentStart.getTime() - booking.reschedule_cutoff_min * 60000) {
      throw Object.assign(
        new Error('This booking is too close to its start time to reschedule online — please cancel instead'),
        { status: 400 }
      );
    }

    const requested = new Date(newStart);
    if (isNaN(requested.getTime())) {
      throw Object.assign(new Error('Invalid start time'), { status: 400 });
    }
    const dateStr = `${requested.getFullYear()}-${String(requested.getMonth() + 1).padStart(2, '0')}-${String(requested.getDate()).padStart(2, '0')}`;

    // re-validates schedule windows, breaks, buffers, lead time and horizon
    const { slots } = await computeSlots(client, booking.provider_id, booking.service_id, dateStr, bookingId);
    const slot = slots.find((s) => new Date(s.start).getTime() === requested.getTime());
    if (!slot) throw new BookingConflictError('That slot is no longer available.');

    const { rows: [updated] } = await client.query(
      `UPDATE bookings SET starts_at = $2, ends_at = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [bookingId, slot.start, slot.end]
    );
    await client.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'rescheduled', $2, $3)`,
      [bookingId, actor, `From ${currentStart.toISOString()} to ${slot.start}`]
    );

    await client.query('COMMIT');
    return updated;
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') throw new BookingConflictError();
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The single cancellation hub — every cancel path (customer manage page,
 * admin status change) goes through here.
 */
export async function cancelBooking(bookingId: number, actor: string, reason = '') {
  const client = await pool.connect();
  let booking: any;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    booking = rows[0];
    if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
    if (booking.status !== 'confirmed') {
      throw Object.assign(new Error(`This booking is already ${booking.status}`), { status: 400 });
    }

    await client.query(`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [bookingId]);
    await client.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'cancelled', $2, $3)`,
      [bookingId, actor, reason]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { booking };
}

/** Full booking row joined with customer, service, provider. */
export async function getBookingDetail(where: string, params: unknown[]) {
  const { rows } = await pool.query(
    `SELECT b.*,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            s.name AS service_name, s.duration_min,
            p.name AS provider_name, p.title AS provider_title, p.emoji, p.color,
            p.reschedule_cutoff_min,
            EXISTS(SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS reviewed
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services  s ON s.id = b.service_id
     JOIN providers p ON p.id = b.provider_id
     WHERE ${where}`,
    params
  );
  return rows[0] ?? null;
}
