# Real-Time Bidding Platform

A minimal, token/cost-efficient backend: Express + Socket.io + Postgres (row locking) + Redis (leaderboard cache).

**Files (intentionally kept to 5):**
- `server.js` — routes, bid transaction logic, socket events
- `db.js` — Postgres pool + Redis client (shared connections)
- `schema.sql` — table definitions
- `public/test.html` — zero-dependency browser client for manual testing
- `.env.example` — config template

## How it works

- **No double-bidding:** every bid runs inside a Postgres transaction that does
  `SELECT ... FOR UPDATE` on the auction row, locking it until the bid is validated
  and committed. A second concurrent bid has to wait for the lock, then sees the
  updated price and is rejected if it's too low.
- **Fast leaderboard:** the top bids per auction are cached in a Redis sorted set
  (`ZADD`/`ZREVRANGE`), so repeated leaderboard reads don't hit Postgres. The DB
  is always the source of truth; Redis is rebuilt from it if the cache is cold.
- **Live updates:** Socket.io broadcasts a `bid:new` event to everyone watching
  that auction the moment a bid is committed.

---

## 1. Set up your free databases

### Postgres — Supabase (or Neon)
1. Create a free project at [supabase.com](https://supabase.com) (or [neon.tech](https://neon.tech)).
2. Supabase: go to **Project Settings → Database → Connection string → URI**. Copy it.
   Neon: go to your **Dashboard → Connection Details** and copy the connection string.
3. It looks like: `postgresql://user:password@host:5432/postgres`

### Redis — Upstash
1. Create a free database at [upstash.com](https://upstash.com).
2. On the database page, copy the **Redis URL** (the `rediss://...` one — it already includes TLS + password).

### Put both in `.env`
```bash
cp .env.example .env
```
Paste your two URLs into `.env`:
```
DATABASE_URL=postgresql://user:password@host:5432/postgres
REDIS_URL=rediss://default:password@host:6379
PORT=3000
```

---

## 2. Run it locally

```bash
npm install
npm run migrate   # creates the auctions/bids tables (safe to re-run)
npm start
```

Open **http://localhost:3000/test.html** in two browser tabs.
1. Create an auction (quickest way — run this once in another terminal):
   ```bash
   curl -X POST http://localhost:3000/api/auctions \
     -H "Content-Type: application/json" \
     -d '{"item_name":"Vintage Camera","starting_price":5,"ends_at":"2026-12-31T00:00:00Z"}'
   ```
2. In both tabs, set Auction ID to the `id` returned above and place bids.
   You should see `bid:new` appear live in both tabs instantly.
3. Try bidding a lower/equal amount from both tabs at once — only the higher one wins; the other gets a 400 error, proving the lock works.

---

## 3. Deploy for free (Render or Railway)

### Option A — Render
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New → Web Service** → connect your repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment**, add `DATABASE_URL` and `REDIS_URL` (paste the same values from your `.env`). Render sets `PORT` automatically.
5. Deploy. Once live, run the migration once via Render's **Shell** tab:
   ```bash
   npm run migrate
   ```

### Option B — Railway
1. Push this folder to a GitHub repo.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**.
3. In the service's **Variables** tab, add `DATABASE_URL` and `REDIS_URL`.
4. Railway auto-detects `npm start` from `package.json`. Deploy.
5. Open the Railway **Shell** (or use `railway run npm run migrate` from your local CLI) once to create the tables.

That's it — your live URL serves the API, the socket connection, and `/test.html` for a quick smoke test.

---

## API Reference

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auctions` | `{item_name, starting_price, ends_at}` | Create auction |
| GET | `/api/auctions` | — | List all |
| GET | `/api/auctions/:id` | — | Detail + cached leaderboard |
| POST | `/api/auctions/:id/bid` | `{bidder, amount}` | Locked, transactional bid |

Socket events: emit `auction:join` / `auction:leave` with an auction id; listen for `bid:new`.
