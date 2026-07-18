import 'dotenv/config';
import pg from 'pg';
import Redis from 'ioredis';
import fs from 'fs';

// Fail loudly and immediately if the .env file is missing or incomplete —
// without this, pg/ioredis silently fall back to localhost defaults, which
// produces confusing "SSL not supported" / "ECONNREFUSED" errors instead.
for (const key of ['DATABASE_URL', 'REDIS_URL']) {
  if (!process.env[key]) {
    console.error(`\nMissing ${key}. Create a .env file in the project root (copy .env.example) and fill in real values.\n`);
    process.exit(1);
  }
}

// --- Postgres (Supabase / Neon) ---
// Both providers require SSL on external connections; rejectUnauthorized:false
// avoids needing the CA bundle for a free-tier setup.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Redis (Upstash) ---
// Upstash gives a single rediss:// URL that already encodes TLS + auth.
export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3
});

// Keys: `auction:{id}:lb` (sorted set: bidder -> amount, for leaderboard)
//       `auction:{id}:price` (string: cached current price, short TTL)
export const lbKey = (id) => `auction:${id}:lb`;
export const priceKey = (id) => `auction:${id}:price`;

export async function runMigration() {
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('Migration applied.');
  process.exit(0);
}