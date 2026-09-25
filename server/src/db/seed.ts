import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

/**
 * Wipes business data and creates a blank slate: just the admin login and an
 * empty provider row (so the app has something to point at). No services,
 * schedule, customers, bookings, or reviews — set those up from the admin
 * panel (Settings → Details/Services/Schedule).
 */
async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE reviews, booking_events, bookings, customers, time_off, breaks,
                schedules, services, providers, users
       RESTART IDENTITY CASCADE`
    );

    // ---- admin user -------------------------------------------------------
    const hash = await bcrypt.hash('admin123', 10);
    await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)`,
      ['admin@bookit.local', hash, 'Admin']
    );

    // ---- blank provider row (fill in via Admin → Settings) -----------------
    await client.query(
      `INSERT INTO providers (name, title, bio) VALUES ('', '', '')`
    );

    await client.query('COMMIT');
    console.log(
      '✔ Seeded: admin login (admin@bookit.local / admin123) and a blank provider. ' +
      'Set up the doctor profile, services and schedule from Admin → Settings.'
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
