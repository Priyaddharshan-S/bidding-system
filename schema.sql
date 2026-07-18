CREATE TABLE IF NOT EXISTS auctions (
  id SERIAL PRIMARY KEY,
  item_name TEXT NOT NULL,
  starting_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  current_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  highest_bidder TEXT,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bids (
  id SERIAL PRIMARY KEY,
  auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);
