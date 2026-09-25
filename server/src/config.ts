import dotenv from 'dotenv';
dotenv.config();

// Schedules are stored as wall-clock times ("19:00") and slots are built with
// local-time Date math, so the process must run in the clinic's timezone —
// Vercel's functions default to UTC, which would shift every slot by hours.
process.env.TZ = process.env.CLINIC_TIMEZONE ?? 'Asia/Karachi';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/appointments';

// Hosted databases (Supabase etc.) need TLS; a local Postgres usually doesn't.
// DB_SSL=true/false overrides the guess made from the hostname.
const isLocalDb = ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname);
const useSsl = process.env.DB_SSL ? process.env.DB_SSL === 'true' : !isLocalDb;

// Refuse to sign admin tokens with the public fallback secret in a deployment
if (process.env.VERCEL && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in the Vercel project environment');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl,
  // Supabase's certificate chains to its own CA, which Node doesn't trust by default
  dbSsl: useSsl ? { rejectUnauthorized: false } : undefined,
  dbPool: {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5_000),
  },
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
};
