import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.dbSsl,
  ...config.dbPool,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err.message);
});
