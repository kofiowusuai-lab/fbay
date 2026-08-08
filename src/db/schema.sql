PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  query TEXT NOT NULL,
  category TEXT,
  city TEXT NOT NULL,
  radius_km INTEGER NOT NULL DEFAULT 40,
  min_price_cents INTEGER,
  max_price_cents INTEGER,
  sort TEXT NOT NULL DEFAULT 'creation_time_descend',
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_id TEXT NOT NULL UNIQUE,
  watch_id INTEGER REFERENCES watches(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  url TEXT NOT NULL,
  city TEXT,
  image_urls TEXT,
  seller_name TEXT,
  listed_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  delivery TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_watch ON listings(watch_id, last_seen_at);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_history_fb ON price_history(fb_id, observed_at);

CREATE TABLE IF NOT EXISTS identities (
  content_hash TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  variant TEXT,
  capacity TEXT,
  model_year INTEGER,
  category TEXT NOT NULL,
  condition TEXT NOT NULL,
  identity_confidence REAL NOT NULL,
  query TEXT NOT NULL,
  must_tokens TEXT NOT NULL,
  weight_lb REAL,
  model_used TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_key ON identities(identity_key);

CREATE TABLE IF NOT EXISTS compsets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_key TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  trimmed_median_cents INTEGER,
  p25_cents INTEGER,
  p75_cents INTEGER,
  sample_n INTEGER NOT NULL,
  raw_n INTEGER NOT NULL,
  active_count INTEGER NOT NULL,
  sold_count INTEGER NOT NULL,
  sell_through REAL,
  active_count_available INTEGER NOT NULL DEFAULT 1,
  sold_per_week REAL,
  days_of_supply REAL,
  confidence REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compsets_key ON compsets(identity_key, expires_at);

CREATE TABLE IF NOT EXISTS comps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compset_id INTEGER NOT NULL REFERENCES compsets(id) ON DELETE CASCADE,
  ebay_item_id TEXT,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  shipping_cents INTEGER,
  sold_at INTEGER,
  condition TEXT,
  url TEXT,
  included INTEGER NOT NULL,
  exclude_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_comps_set ON comps(compset_id);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  identity_key TEXT,
  compset_id INTEGER REFERENCES compsets(id) ON DELETE SET NULL,
  gross_cents INTEGER,
  net_profit_cents INTEGER,
  roi REAL,
  margin REAL,
  breakeven_buy_cents INTEGER,
  score REAL,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'new',
  rejections TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_listing ON deals(listing_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status, score);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  offer_cents INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  sent_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER REFERENCES watches(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  listings_seen INTEGER NOT NULL DEFAULT 0,
  listings_new INTEGER NOT NULL DEFAULT 0,
  deals_found INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS canaries (
  name TEXT PRIMARY KEY,
  last_ok_at INTEGER,
  last_fail_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
