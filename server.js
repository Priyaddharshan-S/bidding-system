import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { pool, redis, lbKey, priceKey } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves public/test.html at /test.html

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Helpers ----------
const room = (id) => `auction:${id}`;

// Refresh Redis cache for an auction's leaderboard + price after a change.
async function cacheBid(auctionId, bidder, amount) {
  await redis.zadd(lbKey(auctionId), amount, bidder);
  await redis.set(priceKey(auctionId), amount, 'EX', 3600); // 1h TTL, DB is source of truth
}

// ---------- REST API ----------

// Create an auction
app.post('/api/auctions', async (req, res) => {
  const { item_name, starting_price = 0, ends_at } = req.body;
  if (!item_name || !ends_at) {
    return res.status(400).json({ error: 'item_name and ends_at are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO auctions (item_name, starting_price, current_price, ends_at)
     VALUES ($1, $2, $2, $3) RETURNING *`,
    [item_name, starting_price, ends_at]
  );
  res.status(201).json(rows[0]);
});

// List all auctions
app.get('/api/auctions', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM auctions ORDER BY created_at DESC');
  res.json(rows);
});

// Get one auction + cached leaderboard (top 5, from Redis, falls back to DB)
app.get('/api/auctions/:id', async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('SELECT * FROM auctions WHERE id=$1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Auction not found' });

  let leaderboard = await redis.zrevrange(lbKey(id), 0, 4, 'WITHSCORES');
  if (leaderboard.length === 0) {
    // Cold cache: rebuild from DB once, then let future bids keep it warm.
    const top = await pool.query(
      `SELECT bidder, amount FROM bids WHERE auction_id=$1 ORDER BY amount DESC LIMIT 5`,
      [id]
    );
    for (const b of top.rows) await redis.zadd(lbKey(id), b.amount, b.bidder);
    leaderboard = await redis.zrevrange(lbKey(id), 0, 4, 'WITHSCORES');
  }

  const board = [];
  for (let i = 0; i < leaderboard.length; i += 2) {
    board.push({ bidder: leaderboard[i], amount: Number(leaderboard[i + 1]) });
  }
  res.json({ ...rows[0], leaderboard: board });
});

// Place a bid — this is the critical section.
// SELECT ... FOR UPDATE locks the auction row for the duration of the
// transaction so two simultaneous bids can never both "win" the same price.
app.post('/api/auctions/:id/bid', async (req, res) => {
  const { id } = req.params;
  const { bidder, amount } = req.body;
  if (!bidder || !amount) return res.status(400).json({ error: 'bidder and amount are required' });

  const client = await pool.connect();
  let committed = false;
  let released = false;
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT current_price, ends_at FROM auctions WHERE id=$1 FOR UPDATE',
      [id]
    );
    const auction = rows[0];
    if (!auction) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Auction not found' });
    }
    if (new Date(auction.ends_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Auction has ended' });
    }
    if (Number(amount) <= Number(auction.current_price)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Bid must exceed current price of ${auction.current_price}` });
    }

    await client.query(
      'UPDATE auctions SET current_price=$1, highest_bidder=$2 WHERE id=$3',
      [amount, bidder, id]
    );
    await client.query(
      'INSERT INTO bids (auction_id, bidder, amount) VALUES ($1, $2, $3)',
      [id, bidder, amount]
    );

    await client.query('COMMIT');
    committed = true;

    // Redis cache failures must never re-trigger a ROLLBACK — the DB write already committed.
    try {
      await cacheBid(id, bidder, amount);
    } catch (cacheErr) {
      console.error('Redis cache update failed (bid still committed):', cacheErr.message);
    }

    const payload = { auctionId: Number(id), bidder, amount: Number(amount), at: new Date().toISOString() };
    io.to(room(id)).emit('bid:new', payload);

    res.status(201).json(payload);
  } catch (err) {
    console.error(err);
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // Connection is in an unknown/broken state — tell pg to discard it
        // rather than recycle it, so it can never hold a stale lock on future requests.
        console.error('ROLLBACK failed, discarding connection:', rollbackErr.message);
        released = true;
        client.release(rollbackErr);
      }
    }
    res.status(500).json({ error: 'Internal error placing bid' });
  } finally {
    if (!released) client.release();
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.on('auction:join', (auctionId) => socket.join(room(auctionId)));
  socket.on('auction:leave', (auctionId) => socket.leave(room(auctionId)));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`RTB platform listening on :${PORT}`));
