# FBay Arbitrage Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a system that finds underpriced Facebook Marketplace listings, values them against real eBay sold prices, computes net profit after fees and shipping, and alerts the operator with a breakeven buy price.

**Architecture:** Six isolated stages (source → identify → comps → economics → score → notify) connected by a SQLite pipeline. The two pure-math stages (`economics`, `score`) have zero I/O and are fully unit-tested. Every network-touching stage parses through a pure function fed by fixtures, so parsers are testable without live requests.

**Tech Stack:** Node 22 ESM (`.mjs`), `node --test`, better-sqlite3 13, Playwright 1.62, cheerio 1.2, @anthropic-ai/sdk 0.116, Next.js 15 (dashboard only).

**Spec:** `docs/superpowers/specs/2026-08-08-fbay-arbitrage-engine-design.md`

---

## Conventions For Every Task

- Node ESM only. Every source file is `.mjs`. No TypeScript, no build step, no bundler.
- Tests live in `test/<module>.test.mjs` and run with `node --test test/*.test.mjs`.
- **Dependency injection over mocking.** Every module that touches network, time, randomness, or the filesystem accepts those as constructor/parameter arguments with real defaults. Tests pass fakes. There is no mocking library.
- Money is **always integer cents**. Never floats for currency. A function that returns dollars is a bug.
- No function throws for an expected failure. Network layers return `{ ok: false, error }` shaped results. Only programmer errors throw.
- Commit after every task with a green test run.

## File Structure

| File | Responsibility |
|---|---|
| `src/config.mjs` | Load and validate `config.json` + env, apply defaults |
| `src/db/schema.sql` | Full DDL, one file, idempotent |
| `src/db/db.mjs` | Open connection, run migrations, pragmas |
| `src/db/repo.mjs` | All SQL. The only file that knows SQLite exists |
| `src/economics/fees.mjs` | eBay fee table, FVF rate lookup, per-order fee |
| `src/economics/shipping.mjs` | Category → weight band → shipping cost, freight flag |
| `src/economics/profit.mjs` | Net profit, ROI, margin, breakeven buy price |
| `src/comps/stats.mjs` | Comp filtering, IQR trimming, median, sell-through, confidence |
| `src/comps/ebay-browse.mjs` | eBay Browse API OAuth + active-listing search |
| `src/comps/ebay-sold.mjs` | eBay sold-listing fetch + multi-strategy HTML parse |
| `src/comps/index.mjs` | Blend sold + active into a cached CompSet |
| `src/score/filters.mjs` | Hard reject rules, each with a recorded reason |
| `src/score/rank.mjs` | Composite weighted score |
| `src/source/facebook/pace.mjs` | Request budgets, human-like delays, block backoff |
| `src/source/facebook/session.mjs` | Persistent Playwright context, login state, block detection |
| `src/source/facebook/search.mjs` | Watch → Marketplace search URL |
| `src/source/facebook/parse.mjs` | Raw DOM nodes → RawListing (pure) |
| `src/source/facebook/detail.mjs` | Raw detail-page text → description, seller, images, delivery (pure) |
| `src/source/facebook/index.mjs` | Source implementation wiring the above |
| `src/llm.mjs` | Single Claude client, forced structured output, retries |
| `src/identify/extract.mjs` | Listing → canonical Identity |
| `src/identify/cache.mjs` | Content hash, identity key |
| `src/notify/telegram.mjs` | Deal card delivery |
| `src/notify/draft.mjs` | Seller offer message generation |
| `src/watch/canary.mjs` | Parser health checks with known-good expectations |
| `src/watch/runner.mjs` | Orchestrate one watch through all stages |
| `src/watch/schedule.mjs` | Interval loop, quiet hours, jitter |
| `src/cli.mjs` | Command router |
| `fbay` | Bash wrapper |
| `dashboard/` | Next.js 15 read-mostly UI |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `.env.example`, `config.example.json`, `src/config.mjs`
- Test: `test/config.test.mjs`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "fbay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "fbay": "./src/cli.mjs" },
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "doctor": "node src/cli.mjs doctor"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.116.0",
    "better-sqlite3": "^13.0.3",
    "cheerio": "^1.2.0",
    "dotenv": "^17.4.2",
    "playwright": "^1.62.1"
  },
  "engines": { "node": ">=22" }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd ~/fbay && npm install`
Expected: `added N packages`, no build failure from better-sqlite3. If better-sqlite3 fails to build, run `npm rebuild better-sqlite3 --build-from-source`.

- [ ] **Step 3: Write the failing config test**

Create `test/config.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, mergeConfig, validateConfig, requireEnv } from '../src/config.mjs'

test('mergeConfig deep-merges user config over defaults', () => {
  const merged = mergeConfig({ thresholds: { minRoi: 0.9 } })
  assert.equal(merged.thresholds.minRoi, 0.9)
  assert.equal(merged.thresholds.minSellThrough, DEFAULTS.thresholds.minSellThrough)
  assert.equal(merged.economics.defaultFvfRate, DEFAULTS.economics.defaultFvfRate)
})

test('mergeConfig does not mutate DEFAULTS', () => {
  mergeConfig({ thresholds: { minRoi: 0.9 } })
  assert.equal(DEFAULTS.thresholds.minRoi, 0.5)
})

test('validateConfig rejects out-of-range rates', () => {
  const r = validateConfig(mergeConfig({ economics: { defaultFvfRate: 1.5 } }))
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /defaultFvfRate/)
})

test('validateConfig accepts the default config', () => {
  assert.equal(validateConfig(mergeConfig({})).ok, true)
})

test('requireEnv reports every missing key at once', () => {
  const r = requireEnv({ FOO: 'x' }, ['FOO', 'BAR', 'BAZ'])
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['BAR', 'BAZ'])
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL, `Cannot find module '../src/config.mjs'`

- [ ] **Step 5: Implement src/config.mjs**

```js
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULTS = {
  marketplace: 'EBAY_US',
  currency: 'USD',
  compsTtlHours: 168,
  thresholds: {
    minNetProfitCents: 3000,
    minRoi: 0.5,
    minSellThrough: 0.30,
    minIdentityConfidence: 0.6,
    minCompSampleSize: 5,
    maxAskCents: 200000,
  },
  economics: {
    defaultFvfRate: 0.1325,
    promotedRate: 0,
    bufferRate: 0.05,
  },
  weights: {
    profit: 0.35,
    roi: 0.25,
    velocity: 0.20,
    confidence: 0.15,
    age: 0.05,
    drop: 0.10,
  },
  freight: { enabled: false },
  pace: {
    maxListingsPerDay: 600,
    maxRequestsPerHour: 120,
    minDelayMs: 1800,
    maxDelayMs: 6500,
    detailFetchRatio: 0.35,
  },
  quietHours: { start: 23, end: 7 },
  blacklist: { keywords: ['broken', 'as is', 'for parts', 'no returns', 'scam'], sellers: [] },
}

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function mergeConfig (user = {}, base = DEFAULTS) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(user)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeConfig(v, base[k]) : v
  }
  return out
}

const RATE_KEYS = [
  ['economics.defaultFvfRate', 0, 1],
  ['economics.promotedRate', 0, 1],
  ['economics.bufferRate', 0, 1],
  ['thresholds.minSellThrough', 0, 1],
  ['thresholds.minIdentityConfidence', 0, 1],
]

function get (obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
}

export function validateConfig (config) {
  const errors = []
  for (const [key, min, max] of RATE_KEYS) {
    const v = get(config, key)
    if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max) {
      errors.push(`${key} must be a number between ${min} and ${max}, got ${v}`)
    }
  }
  if (config.thresholds.minCompSampleSize < 1) {
    errors.push('thresholds.minCompSampleSize must be at least 1')
  }
  if (config.pace.minDelayMs > config.pace.maxDelayMs) {
    errors.push('pace.minDelayMs must not exceed pace.maxDelayMs')
  }
  return { ok: errors.length === 0, errors }
}

export function requireEnv (env, keys) {
  const missing = keys.filter((k) => !env[k])
  return { ok: missing.length === 0, missing }
}

export function loadConfig (configPath = path.join(process.cwd(), 'config.json')) {
  let user = {}
  if (fs.existsSync(configPath)) {
    user = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  }
  const config = mergeConfig(user)
  const v = validateConfig(config)
  if (!v.ok) {
    throw new Error(`Invalid config at ${configPath}:\n  ${v.errors.join('\n  ')}`)
  }
  return config
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/config.test.mjs`
Expected: `# pass 5`, `# fail 0`

- [ ] **Step 7: Create .env.example and config.example.json**

`.env.example`:

```
# eBay developer credentials - https://developer.ebay.com/my/keys (Production keyset)
EBAY_APP_ID=
EBAY_CERT_ID=

# Anthropic - identity extraction and message drafting
ANTHROPIC_API_KEY=

# Telegram - reuse the existing bot on this machine
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Local paths
FBAY_DB_PATH=./data/fbay.db
FBAY_FB_PROFILE_DIR=./fb-profile
```

`config.example.json`:

```json
{
  "thresholds": {
    "minNetProfitCents": 3000,
    "minRoi": 0.5,
    "minSellThrough": 0.30
  },
  "freight": { "enabled": false },
  "pace": { "maxListingsPerDay": 600 }
}
```

- [ ] **Step 8: Commit**

```bash
cd ~/fbay
git add package.json package-lock.json .env.example config.example.json src/config.mjs test/config.test.mjs
git commit -m "feat: project scaffold and validated config loader"
```

---

## Task 2: Database Schema and Repository

**Files:**
- Create: `src/db/schema.sql`, `src/db/db.mjs`, `src/db/repo.mjs`
- Test: `test/db.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/db.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'

function freshRepo () {
  return createRepo(openDb(':memory:'))
}

test('migrations create every expected table', () => {
  const repo = freshRepo()
  const names = repo.tableNames()
  for (const t of ['watches', 'listings', 'price_history', 'identities', 'compsets', 'comps', 'deals', 'messages', 'runs', 'canaries']) {
    assert.ok(names.includes(t), `missing table ${t}`)
  }
})

test('upsertListing inserts once and records first_seen_at', () => {
  const repo = freshRepo()
  const a = repo.upsertListing({ fbId: 'x1', title: 'iPhone', priceCents: 20000, url: 'u', seenAt: 1000 })
  assert.equal(a.isNew, true)
  const b = repo.upsertListing({ fbId: 'x1', title: 'iPhone', priceCents: 20000, url: 'u', seenAt: 2000 })
  assert.equal(b.isNew, false)
  assert.equal(b.priceChanged, false)
  assert.equal(repo.countListings(), 1)
})

test('upsertListing detects a price drop and writes price history', () => {
  const repo = freshRepo()
  repo.upsertListing({ fbId: 'x1', title: 'iPhone', priceCents: 20000, url: 'u', seenAt: 1000 })
  const b = repo.upsertListing({ fbId: 'x1', title: 'iPhone', priceCents: 15000, url: 'u', seenAt: 2000 })
  assert.equal(b.priceChanged, true)
  assert.equal(b.previousPriceCents, 20000)
  assert.equal(repo.priceHistory('x1').length, 2)
})

test('identity cache round-trips by content hash', () => {
  const repo = freshRepo()
  assert.equal(repo.getIdentityByContentHash('h1'), undefined)
  repo.saveIdentity({ contentHash: 'h1', identityKey: 'k1', brand: 'Apple', model: 'iPhone 13', category: 'phone', condition: 'good', identityConfidence: 0.9, query: 'apple iphone 13', mustTokens: ['iphone', '13'], modelUsed: 'test' })
  const got = repo.getIdentityByContentHash('h1')
  assert.equal(got.identity_key, 'k1')
  assert.deepEqual(JSON.parse(got.must_tokens), ['iphone', '13'])
})

test('compset cache respects expiry', () => {
  const repo = freshRepo()
  repo.saveCompSet({ identityKey: 'k1', marketplace: 'EBAY_US', trimmedMedianCents: 30000, p25Cents: 28000, p75Cents: 32000, sampleN: 8, rawN: 20, activeCount: 40, soldCount: 8, sellThrough: 0.17, soldPerWeek: 2, daysOfSupply: 140, confidence: 0.7, fetchedAt: 1000, expiresAt: 5000 }, [])
  assert.ok(repo.getFreshCompSet('k1', 4000))
  assert.equal(repo.getFreshCompSet('k1', 6000), undefined)
})

test('saveCompSet persists backing comps with exclusion reasons', () => {
  const repo = freshRepo()
  const id = repo.saveCompSet(
    { identityKey: 'k1', marketplace: 'EBAY_US', trimmedMedianCents: 100, p25Cents: 90, p75Cents: 110, sampleN: 1, rawN: 2, activeCount: 1, soldCount: 1, sellThrough: 0.5, soldPerWeek: 1, daysOfSupply: 7, confidence: 0.4, fetchedAt: 1, expiresAt: 2 },
    [
      { ebayItemId: 'a', title: 'good one', priceCents: 100, soldAt: 1, url: 'u', included: true, excludeReason: null },
      { ebayItemId: 'b', title: 'lot of 5', priceCents: 500, soldAt: 1, url: 'u', included: false, excludeReason: 'bundle' },
    ]
  ).id
  const rows = repo.compsFor(id)
  assert.equal(rows.length, 2)
  assert.equal(rows.find((r) => r.ebay_item_id === 'b').exclude_reason, 'bundle')
})

test('recordCanary tracks consecutive failures and resets on success', () => {
  const repo = freshRepo()
  repo.recordCanary('ebay_sold', false, 100)
  repo.recordCanary('ebay_sold', false, 200)
  assert.equal(repo.getCanary('ebay_sold').consecutive_failures, 2)
  repo.recordCanary('ebay_sold', true, 300)
  assert.equal(repo.getCanary('ebay_sold').consecutive_failures, 0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/db.test.mjs`
Expected: FAIL, `Cannot find module '../src/db/db.mjs'`

- [ ] **Step 3: Write src/db/schema.sql**

```sql
PRAGMA journal_mode = WAL;
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
  trimmed_median_cents INTEGER NOT NULL,
  p25_cents INTEGER,
  p75_cents INTEGER,
  sample_n INTEGER NOT NULL,
  raw_n INTEGER NOT NULL,
  active_count INTEGER NOT NULL,
  sold_count INTEGER NOT NULL,
  sell_through REAL NOT NULL,
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
```

- [ ] **Step 4: Write src/db/db.mjs**

```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function openDb (dbPath = process.env.FBAY_DB_PATH || './data/fbay.db') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  }
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL')
  const schema = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8')
  db.exec(schema)
  return db
}
```

- [ ] **Step 5: Write src/db/repo.mjs**

```js
export function createRepo (db) {
  const stmt = (sql) => db.prepare(sql)

  const sel = {
    listingByFbId: stmt('SELECT * FROM listings WHERE fb_id = ?'),
    identityByHash: stmt('SELECT * FROM identities WHERE content_hash = ?'),
    freshCompSet: stmt('SELECT * FROM compsets WHERE identity_key = ? AND expires_at > ? ORDER BY fetched_at DESC LIMIT 1'),
    compsFor: stmt('SELECT * FROM comps WHERE compset_id = ?'),
    priceHistory: stmt('SELECT * FROM price_history WHERE fb_id = ? ORDER BY observed_at'),
    canary: stmt('SELECT * FROM canaries WHERE name = ?'),
  }

  const ins = {
    priceHistory: stmt('INSERT INTO price_history (fb_id, price_cents, observed_at) VALUES (?, ?, ?)'),
    listing: stmt(`INSERT INTO listings (fb_id, watch_id, title, description, price_cents, url, city, image_urls, seller_name, listed_at, first_seen_at, last_seen_at, delivery, raw)
      VALUES (@fbId, @watchId, @title, @description, @priceCents, @url, @city, @imageUrls, @sellerName, @listedAt, @seenAt, @seenAt, @delivery, @raw)`),
    identity: stmt(`INSERT OR REPLACE INTO identities (content_hash, identity_key, brand, model, variant, capacity, model_year, category, condition, identity_confidence, query, must_tokens, weight_lb, model_used, created_at)
      VALUES (@contentHash, @identityKey, @brand, @model, @variant, @capacity, @modelYear, @category, @condition, @identityConfidence, @query, @mustTokens, @weightLb, @modelUsed, @createdAt)`),
    compset: stmt(`INSERT INTO compsets (identity_key, marketplace, trimmed_median_cents, p25_cents, p75_cents, sample_n, raw_n, active_count, sold_count, sell_through, sold_per_week, days_of_supply, confidence, fetched_at, expires_at)
      VALUES (@identityKey, @marketplace, @trimmedMedianCents, @p25Cents, @p75Cents, @sampleN, @rawN, @activeCount, @soldCount, @sellThrough, @soldPerWeek, @daysOfSupply, @confidence, @fetchedAt, @expiresAt)`),
    comp: stmt(`INSERT INTO comps (compset_id, ebay_item_id, title, price_cents, shipping_cents, sold_at, condition, url, included, exclude_reason)
      VALUES (@compsetId, @ebayItemId, @title, @priceCents, @shippingCents, @soldAt, @condition, @url, @included, @excludeReason)`),
  }

  const upd = {
    listingSeen: stmt('UPDATE listings SET last_seen_at = ?, price_cents = ?, is_active = 1 WHERE fb_id = ?'),
    listingDetail: stmt('UPDATE listings SET description = ?, image_urls = ?, seller_name = ?, delivery = ? WHERE fb_id = ?'),
  }

  return {
    db,

    tableNames () {
      return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    },

    countListings () {
      return db.prepare('SELECT COUNT(*) c FROM listings').get().c
    },

    upsertListing (l) {
      const existing = sel.listingByFbId.get(l.fbId)
      const row = {
        fbId: l.fbId,
        watchId: l.watchId ?? null,
        title: l.title,
        description: l.description ?? null,
        priceCents: l.priceCents,
        url: l.url,
        city: l.city ?? null,
        imageUrls: l.imageUrls ? JSON.stringify(l.imageUrls) : null,
        sellerName: l.sellerName ?? null,
        listedAt: l.listedAt ?? null,
        seenAt: l.seenAt,
        delivery: l.delivery ?? null,
        raw: l.raw ? JSON.stringify(l.raw) : null,
      }
      if (!existing) {
        const info = ins.listing.run(row)
        ins.priceHistory.run(l.fbId, l.priceCents, l.seenAt)
        return { isNew: true, id: info.lastInsertRowid, priceChanged: false, previousPriceCents: null }
      }
      const priceChanged = existing.price_cents !== l.priceCents
      upd.listingSeen.run(l.seenAt, l.priceCents, l.fbId)
      if (priceChanged) ins.priceHistory.run(l.fbId, l.priceCents, l.seenAt)
      return { isNew: false, id: existing.id, priceChanged, previousPriceCents: existing.price_cents }
    },

    updateListingDetail (fbId, d) {
      upd.listingDetail.run(d.description ?? null, d.imageUrls ? JSON.stringify(d.imageUrls) : null, d.sellerName ?? null, d.delivery ?? null, fbId)
    },

    getListing (fbId) { return sel.listingByFbId.get(fbId) },
    priceHistory (fbId) { return sel.priceHistory.all(fbId) },

    getIdentityByContentHash (h) { return sel.identityByHash.get(h) },

    saveIdentity (i) {
      ins.identity.run({
        contentHash: i.contentHash,
        identityKey: i.identityKey,
        brand: i.brand ?? null,
        model: i.model ?? null,
        variant: i.variant ?? null,
        capacity: i.capacity ?? null,
        modelYear: i.modelYear ?? null,
        category: i.category,
        condition: i.condition,
        identityConfidence: i.identityConfidence,
        query: i.query,
        mustTokens: JSON.stringify(i.mustTokens ?? []),
        weightLb: i.weightLb ?? null,
        modelUsed: i.modelUsed ?? null,
        createdAt: i.createdAt ?? Date.now(),
      })
    },

    getFreshCompSet (identityKey, now) { return sel.freshCompSet.get(identityKey, now) },

    saveCompSet (cs, comps = []) {
      const tx = db.transaction(() => {
        const info = ins.compset.run({
          identityKey: cs.identityKey,
          marketplace: cs.marketplace,
          trimmedMedianCents: cs.trimmedMedianCents,
          p25Cents: cs.p25Cents ?? null,
          p75Cents: cs.p75Cents ?? null,
          sampleN: cs.sampleN,
          rawN: cs.rawN,
          activeCount: cs.activeCount,
          soldCount: cs.soldCount,
          sellThrough: cs.sellThrough,
          soldPerWeek: cs.soldPerWeek ?? null,
          daysOfSupply: cs.daysOfSupply ?? null,
          confidence: cs.confidence,
          fetchedAt: cs.fetchedAt,
          expiresAt: cs.expiresAt,
        })
        const id = info.lastInsertRowid
        for (const c of comps) {
          ins.comp.run({
            compsetId: id,
            ebayItemId: c.ebayItemId ?? null,
            title: c.title,
            priceCents: c.priceCents,
            shippingCents: c.shippingCents ?? null,
            soldAt: c.soldAt ?? null,
            condition: c.condition ?? null,
            url: c.url ?? null,
            included: c.included ? 1 : 0,
            excludeReason: c.excludeReason ?? null,
          })
        }
        return id
      })
      return { id: tx() }
    },

    compsFor (compsetId) { return sel.compsFor.all(compsetId) },

    upsertDeal (d) {
      const existing = db.prepare('SELECT id FROM deals WHERE listing_id = ?').get(d.listingId)
      const row = {
        listingId: d.listingId,
        identityKey: d.identityKey ?? null,
        compsetId: d.compsetId ?? null,
        grossCents: d.grossCents ?? null,
        netProfitCents: d.netProfitCents ?? null,
        roi: d.roi ?? null,
        margin: d.margin ?? null,
        breakevenBuyCents: d.breakevenBuyCents ?? null,
        score: d.score ?? null,
        confidence: d.confidence ?? null,
        status: d.status ?? 'new',
        rejections: d.rejections ? JSON.stringify(d.rejections) : null,
        error: d.error ?? null,
        now: d.now ?? Date.now(),
      }
      if (existing) {
        db.prepare(`UPDATE deals SET identity_key=@identityKey, compset_id=@compsetId, gross_cents=@grossCents,
          net_profit_cents=@netProfitCents, roi=@roi, margin=@margin, breakeven_buy_cents=@breakevenBuyCents,
          score=@score, confidence=@confidence, status=@status, rejections=@rejections, error=@error, updated_at=@now
          WHERE listing_id=@listingId`).run(row)
        return { id: existing.id, isNew: false }
      }
      const info = db.prepare(`INSERT INTO deals (listing_id, identity_key, compset_id, gross_cents, net_profit_cents, roi, margin, breakeven_buy_cents, score, confidence, status, rejections, error, created_at, updated_at)
        VALUES (@listingId, @identityKey, @compsetId, @grossCents, @netProfitCents, @roi, @margin, @breakevenBuyCents, @score, @confidence, @status, @rejections, @error, @now, @now)`).run(row)
      return { id: info.lastInsertRowid, isNew: true }
    },

    listDeals ({ status, limit = 50 } = {}) {
      const sql = status
        ? 'SELECT d.*, l.title, l.price_cents ask_cents, l.url, l.image_urls FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.status = ? ORDER BY d.score DESC LIMIT ?'
        : 'SELECT d.*, l.title, l.price_cents ask_cents, l.url, l.image_urls FROM deals d JOIN listings l ON l.id = d.listing_id ORDER BY d.score DESC LIMIT ?'
      return status ? db.prepare(sql).all(status, limit) : db.prepare(sql).all(limit)
    },

    setDealStatus (id, status, now = Date.now()) {
      db.prepare('UPDATE deals SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
    },

    saveMessage (m) {
      const info = db.prepare('INSERT INTO messages (deal_id, body, offer_cents, generated_at, status) VALUES (?, ?, ?, ?, ?)')
        .run(m.dealId, m.body, m.offerCents, m.generatedAt ?? Date.now(), m.status ?? 'draft')
      return { id: info.lastInsertRowid }
    },

    startRun (watchId, now) {
      return db.prepare('INSERT INTO runs (watch_id, started_at) VALUES (?, ?)').run(watchId ?? null, now).lastInsertRowid
    },

    finishRun (id, { now, listingsSeen, listingsNew, dealsFound, errors, status }) {
      db.prepare('UPDATE runs SET finished_at=?, listings_seen=?, listings_new=?, deals_found=?, errors=?, status=? WHERE id=?')
        .run(now, listingsSeen, listingsNew, dealsFound, errors ? JSON.stringify(errors) : null, status, id)
    },

    addWatch (w) {
      const info = db.prepare(`INSERT INTO watches (name, query, category, city, radius_km, min_price_cents, max_price_cents, sort, interval_minutes, created_at)
        VALUES (@name, @query, @category, @city, @radiusKm, @minPriceCents, @maxPriceCents, @sort, @intervalMinutes, @createdAt)`).run({
        name: w.name, query: w.query, category: w.category ?? null, city: w.city,
        radiusKm: w.radiusKm ?? 40, minPriceCents: w.minPriceCents ?? null, maxPriceCents: w.maxPriceCents ?? null,
        sort: w.sort ?? 'creation_time_descend', intervalMinutes: w.intervalMinutes ?? 60, createdAt: w.createdAt ?? Date.now(),
      })
      return { id: info.lastInsertRowid }
    },

    listWatches ({ enabledOnly = false } = {}) {
      return enabledOnly
        ? db.prepare('SELECT * FROM watches WHERE enabled = 1 ORDER BY name').all()
        : db.prepare('SELECT * FROM watches ORDER BY name').all()
    },

    setWatchEnabled (name, enabled) {
      db.prepare('UPDATE watches SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name)
    },

    touchWatch (id, now) {
      db.prepare('UPDATE watches SET last_run_at = ? WHERE id = ?').run(now, id)
    },

    recordCanary (name, ok, now, detail = null) {
      const row = sel.canary.get(name)
      if (!row) {
        db.prepare('INSERT INTO canaries (name, last_ok_at, last_fail_at, consecutive_failures, detail) VALUES (?, ?, ?, ?, ?)')
          .run(name, ok ? now : null, ok ? null : now, ok ? 0 : 1, detail)
        return
      }
      db.prepare('UPDATE canaries SET last_ok_at = ?, last_fail_at = ?, consecutive_failures = ?, detail = ? WHERE name = ?')
        .run(ok ? now : row.last_ok_at, ok ? row.last_fail_at : now, ok ? 0 : row.consecutive_failures + 1, detail, name)
    },

    getCanary (name) { return sel.canary.get(name) },

    prune (beforeTs) {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM comps WHERE compset_id IN (SELECT id FROM compsets WHERE fetched_at < ?)').run(beforeTs)
        db.prepare('DELETE FROM compsets WHERE fetched_at < ?').run(beforeTs)
        db.prepare('DELETE FROM listings WHERE last_seen_at < ? AND id NOT IN (SELECT listing_id FROM deals WHERE status IN (\'bought\',\'pursuing\'))').run(beforeTs)
      })
      tx()
    },

    stats () {
      return {
        listings: db.prepare('SELECT COUNT(*) c FROM listings').get().c,
        deals: db.prepare('SELECT COUNT(*) c FROM deals').get().c,
        identities: db.prepare('SELECT COUNT(*) c FROM identities').get().c,
        compsets: db.prepare('SELECT COUNT(*) c FROM compsets').get().c,
        watches: db.prepare('SELECT COUNT(*) c FROM watches').get().c,
      }
    },
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/db.test.mjs`
Expected: `# pass 7`, `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add src/db test/db.test.mjs
git commit -m "feat: sqlite schema and repository with price history, caches, canaries"
```

---

## Task 3: eBay Fee Table

**Files:**
- Create: `src/economics/fees.mjs`
- Test: `test/fees.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/fees.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fvfRate, perOrderFeeCents, computeFees, FEE_TABLE } from '../src/economics/fees.mjs'

test('unknown category falls back to the default rate', () => {
  assert.equal(fvfRate('nonexistent_category'), FEE_TABLE.default)
})

test('known category overrides the default rate', () => {
  assert.equal(fvfRate('athletic_shoes'), 0.08)
  assert.equal(fvfRate('books_movies_music'), 0.153)
})

test('per-order fee uses the sub-$10 band', () => {
  assert.equal(perOrderFeeCents(999), 40)
  assert.equal(perOrderFeeCents(1000), 30)
  assert.equal(perOrderFeeCents(50000), 30)
})

test('computeFees returns exact integer cents', () => {
  const f = computeFees({ grossCents: 30000, category: 'phone', promotedRate: 0 })
  assert.equal(f.fvfCents, 3975)   // 30000 * 0.1325
  assert.equal(f.perOrderCents, 30)
  assert.equal(f.promotedCents, 0)
  assert.equal(f.totalCents, 4005)
  assert.equal(Number.isInteger(f.totalCents), true)
})

test('computeFees applies the promoted-listing rate', () => {
  const f = computeFees({ grossCents: 10000, category: 'phone', promotedRate: 0.03 })
  assert.equal(f.promotedCents, 300)
  assert.equal(f.totalCents, 1325 + 30 + 300)
})

test('computeFees rounds half up on fractional cents', () => {
  const f = computeFees({ grossCents: 1001, category: 'phone', promotedRate: 0 })
  assert.equal(f.fvfCents, 133)  // 132.6325 -> 133
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/fees.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/economics/fees.mjs**

```js
// eBay final value fee rates by internal category key.
// Source: ebay.com/help/selling/fees-credits-invoices/selling-fees, verified 2026-08-08.
// These change. Update here only, nothing else reads rates.
export const FEE_TABLE = {
  default: 0.1325,
  phone: 0.1325,
  laptop: 0.1325,
  tablet: 0.1325,
  camera: 0.1325,
  audio: 0.1325,
  gaming_console: 0.1325,
  gaming_accessory: 0.1325,
  tv: 0.1325,
  tools: 0.1325,
  appliance: 0.1325,
  furniture: 0.1325,
  bicycle: 0.1325,
  exercise_equipment: 0.1325,
  clothing: 0.1325,
  athletic_shoes: 0.08,          // athletic shoes with a total amount of $150+
  jewelry: 0.15,
  watches: 0.15,
  books_movies_music: 0.153,
  musical_instrument: 0.067,     // guitars and basses
  trading_cards: 0.1325,
  heavy_equipment: 0.03,
  toys: 0.1325,
  baby: 0.1325,
  sporting_goods: 0.1325,
  other: 0.1325,
}

export const PER_ORDER_FEE_LOW_CENTS = 40   // orders under $10
export const PER_ORDER_FEE_HIGH_CENTS = 30  // orders $10 and over
export const PER_ORDER_THRESHOLD_CENTS = 1000

export function fvfRate (category) {
  return FEE_TABLE[category] ?? FEE_TABLE.default
}

export function perOrderFeeCents (grossCents) {
  return grossCents < PER_ORDER_THRESHOLD_CENTS ? PER_ORDER_FEE_LOW_CENTS : PER_ORDER_FEE_HIGH_CENTS
}

function roundCents (n) {
  return Math.round(n)
}

export function computeFees ({ grossCents, category, promotedRate = 0 }) {
  const rate = fvfRate(category)
  const fvfCents = roundCents(grossCents * rate)
  const perOrderCents = perOrderFeeCents(grossCents)
  const promotedCents = roundCents(grossCents * promotedRate)
  return {
    rate,
    fvfCents,
    perOrderCents,
    promotedCents,
    totalCents: fvfCents + perOrderCents + promotedCents,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/fees.test.mjs`
Expected: `# pass 6`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/economics/fees.mjs test/fees.test.mjs
git commit -m "feat: eBay fee table with category rates and per-order bands"
```

---

## Task 4: Shipping Cost Bands and Freight Detection

**Files:**
- Create: `src/economics/shipping.mjs`
- Test: `test/shipping.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/shipping.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bandForWeight, shippingFor, CATEGORY_WEIGHT_LB, WEIGHT_BANDS } from '../src/economics/shipping.mjs'

test('bandForWeight picks the first band whose ceiling covers the weight', () => {
  assert.equal(bandForWeight(0.5).key, 'letter')
  assert.equal(bandForWeight(1).key, 'letter')
  assert.equal(bandForWeight(1.01).key, 'small')
  assert.equal(bandForWeight(9).key, 'medium')
  assert.equal(bandForWeight(200).key, 'freight')
})

test('shippingFor uses the category default weight', () => {
  const s = shippingFor({ category: 'phone' })
  assert.equal(s.weightLb, CATEGORY_WEIGHT_LB.phone)
  assert.equal(s.freight, false)
  assert.equal(Number.isInteger(s.costCents), true)
})

test('an explicit weight overrides the category default', () => {
  const s = shippingFor({ category: 'phone', weightLb: 40 })
  assert.equal(s.band.key, 'oversize')
})

test('furniture is flagged as freight with no parcel cost', () => {
  const s = shippingFor({ category: 'furniture' })
  assert.equal(s.freight, true)
  assert.equal(s.costCents, null)
})

test('local pickup resale bypasses shipping entirely', () => {
  const s = shippingFor({ category: 'furniture', localResale: true })
  assert.equal(s.freight, false)
  assert.equal(s.costCents, 0)
})

test('unknown category falls back to the default weight, not a crash', () => {
  const s = shippingFor({ category: 'made_up' })
  assert.equal(s.weightLb, CATEGORY_WEIGHT_LB.default)
})

test('every band except freight has an integer cost', () => {
  for (const b of WEIGHT_BANDS) {
    if (b.key === 'freight') assert.equal(b.costCents, null)
    else assert.equal(Number.isInteger(b.costCents), true)
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/shipping.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/economics/shipping.mjs**

```js
// Parcel cost bands, all-in estimate including packaging materials.
// Calibrated against eBay Standard Envelope / USPS Ground Advantage / UPS Ground
// commercial rates for a mid-distance US shipment, 2026-08-08.
// Deliberately conservative: overestimating shipping kills marginal deals,
// which is the correct bias. A missed deal costs nothing, a bad buy costs money.
export const WEIGHT_BANDS = [
  { key: 'letter', maxLb: 1, costCents: 550 },
  { key: 'small', maxLb: 3, costCents: 950 },
  { key: 'medium', maxLb: 10, costCents: 1650 },
  { key: 'large', maxLb: 25, costCents: 3200 },
  { key: 'oversize', maxLb: 70, costCents: 6500 },
  { key: 'freight', maxLb: Infinity, costCents: null },
]

export const CATEGORY_WEIGHT_LB = {
  default: 5,
  phone: 1,
  tablet: 2,
  laptop: 8,
  camera: 4,
  audio: 6,
  gaming_console: 12,
  gaming_accessory: 2,
  tv: 45,
  tools: 12,
  appliance: 90,
  furniture: 150,
  bicycle: 40,
  exercise_equipment: 180,
  clothing: 2,
  athletic_shoes: 3,
  jewelry: 0.5,
  watches: 1,
  books_movies_music: 2,
  musical_instrument: 20,
  trading_cards: 0.3,
  heavy_equipment: 500,
  toys: 4,
  baby: 15,
  sporting_goods: 10,
  other: 5,
}

export function bandForWeight (weightLb) {
  return WEIGHT_BANDS.find((b) => weightLb <= b.maxLb)
}

export function shippingFor ({ category, weightLb, localResale = false }) {
  const lb = weightLb ?? CATEGORY_WEIGHT_LB[category] ?? CATEGORY_WEIGHT_LB.default
  const band = bandForWeight(lb)
  if (localResale) {
    return { weightLb: lb, band, costCents: 0, freight: false, localResale: true }
  }
  return {
    weightLb: lb,
    band,
    costCents: band.costCents,
    freight: band.costCents === null,
    localResale: false,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/shipping.test.mjs`
Expected: `# pass 7`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/economics/shipping.mjs test/shipping.test.mjs
git commit -m "feat: shipping weight bands with freight detection"
```

---

## Task 5: Profit, ROI and Breakeven Buy Price

**Files:**
- Create: `src/economics/profit.mjs`
- Test: `test/profit.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/profit.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeProfit } from '../src/economics/profit.mjs'
import { DEFAULTS } from '../src/config.mjs'

const cfg = DEFAULTS

// Worked example, computed by hand:
// gross 30000, category phone (0.1325 fvf), ask 12000
// fvf       = 30000 * 0.1325 = 3975
// perOrder  = 30
// shipping  = phone -> 1lb -> letter band -> 550
// promoted  = 0
// buffer    = 30000 * 0.05 = 1500
// breakeven = 30000 - 3975 - 30 - 550 - 0 - 1500 = 23945
// net       = 23945 - 12000 = 11945
// roi       = 11945 / 12000 = 0.99541666...
// margin    = 11945 / 30000 = 0.398166...
test('worked example produces exact expected line items', () => {
  const p = computeProfit({ grossCents: 30000, askCents: 12000, category: 'phone', config: cfg })
  assert.equal(p.fvfCents, 3975)
  assert.equal(p.perOrderCents, 30)
  assert.equal(p.shippingCents, 550)
  assert.equal(p.promotedCents, 0)
  assert.equal(p.bufferCents, 1500)
  assert.equal(p.breakevenBuyCents, 23945)
  assert.equal(p.netCents, 11945)
  assert.ok(Math.abs(p.roi - 0.9954166666) < 1e-6)
  assert.ok(Math.abs(p.margin - 0.3981666666) < 1e-6)
  assert.equal(p.freight, false)
})

test('net is exactly breakeven minus ask', () => {
  const p = computeProfit({ grossCents: 50000, askCents: 31000, category: 'laptop', config: cfg })
  assert.equal(p.netCents, p.breakevenBuyCents - 31000)
})

test('an overpriced ask yields negative net', () => {
  const p = computeProfit({ grossCents: 10000, askCents: 9500, category: 'phone', config: cfg })
  assert.ok(p.netCents < 0)
  assert.ok(p.roi < 0)
})

test('freight categories are flagged and have null net', () => {
  const p = computeProfit({ grossCents: 40000, askCents: 10000, category: 'furniture', config: cfg })
  assert.equal(p.freight, true)
  assert.equal(p.netCents, null)
  assert.equal(p.breakevenBuyCents, null)
})

test('local resale removes shipping and un-flags freight', () => {
  const p = computeProfit({ grossCents: 40000, askCents: 10000, category: 'furniture', config: cfg, localResale: true })
  assert.equal(p.freight, false)
  assert.equal(p.shippingCents, 0)
  assert.equal(p.breakevenBuyCents, 40000 - 5300 - 30 - 0 - 0 - 2000)
})

test('a free item returns null roi rather than Infinity', () => {
  const p = computeProfit({ grossCents: 10000, askCents: 0, category: 'phone', config: cfg })
  assert.equal(p.roi, null)
  assert.ok(p.netCents > 0)
})

test('sub-$10 gross uses the 40c per-order fee band', () => {
  const p = computeProfit({ grossCents: 900, askCents: 100, category: 'phone', config: cfg })
  assert.equal(p.perOrderCents, 40)
})

test('promoted rate from config is applied', () => {
  const promoted = { ...cfg, economics: { ...cfg.economics, promotedRate: 0.04 } }
  const p = computeProfit({ grossCents: 20000, askCents: 5000, category: 'phone', config: promoted })
  assert.equal(p.promotedCents, 800)
})

test('an explicit weight override changes the shipping band', () => {
  const p = computeProfit({ grossCents: 30000, askCents: 5000, category: 'phone', config: cfg, weightLb: 12 })
  assert.equal(p.shippingCents, 3200)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/profit.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/economics/profit.mjs**

```js
import { computeFees } from './fees.mjs'
import { shippingFor } from './shipping.mjs'

/**
 * All money in integer cents. Returns null for net/breakeven on freight items
 * because a parcel estimate would be a lie, and a lie here loses real money.
 */
export function computeProfit ({ grossCents, askCents, category, config, weightLb, localResale = false }) {
  const { promotedRate, bufferRate } = config.economics
  const fees = computeFees({ grossCents, category, promotedRate })
  const ship = shippingFor({ category, weightLb, localResale })
  const bufferCents = Math.round(grossCents * bufferRate)

  const base = {
    grossCents,
    askCents,
    category,
    rate: fees.rate,
    fvfCents: fees.fvfCents,
    perOrderCents: fees.perOrderCents,
    promotedCents: fees.promotedCents,
    bufferCents,
    shippingCents: ship.costCents,
    weightLb: ship.weightLb,
    shippingBand: ship.band.key,
    freight: ship.freight,
    localResale: ship.localResale,
  }

  if (ship.freight) {
    return { ...base, breakevenBuyCents: null, netCents: null, roi: null, margin: null }
  }

  const breakevenBuyCents =
    grossCents - fees.fvfCents - fees.perOrderCents - ship.costCents - fees.promotedCents - bufferCents
  const netCents = breakevenBuyCents - askCents

  return {
    ...base,
    breakevenBuyCents,
    netCents,
    roi: askCents > 0 ? netCents / askCents : null,
    margin: grossCents > 0 ? netCents / grossCents : null,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/profit.test.mjs`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 5: Run the whole suite**

Run: `node --test test/*.test.mjs`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/economics/profit.mjs test/profit.test.mjs
git commit -m "feat: profit, ROI, margin and breakeven buy price"
```

---

## Task 6: Comp Statistics, Trimming and Sell-Through

**Files:**
- Create: `src/comps/stats.mjs`
- Test: `test/stats.test.mjs`

**Note on a spec refinement:** the spec listed `avg_days_to_sell`. eBay sold pages expose the sold date but not the listing start date, so days-to-sell is not computable from available data. This task implements `soldPerWeek` (sold count over the observed date span) and `daysOfSupply` (`activeCount / soldPerDay`) instead. Both are computable and answer the same question honestly. The schema in Task 2 already reflects this.

- [ ] **Step 1: Write the failing test**

Create `test/stats.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, excludeReasonFor, filterComps, median, percentile, iqrTrim, buildCompSet } from '../src/comps/stats.mjs'

const DAY = 86400000

test('tokenize lowercases, strips punctuation and drops empties', () => {
  assert.deepEqual(tokenize('Apple iPhone-13 (128GB), Unlocked!'), ['apple', 'iphone', '13', '128gb', 'unlocked'])
})

test('excludeReasonFor catches lots, bundles and parts-only', () => {
  assert.equal(excludeReasonFor('Lot of 5 iPhone 13'), 'bundle')
  assert.equal(excludeReasonFor('iPhone 13 bundle with case'), 'bundle')
  assert.equal(excludeReasonFor('iPhone 13 FOR PARTS ONLY'), 'parts')
  assert.equal(excludeReasonFor('iPhone 13 read description damaged'), 'damaged')
  assert.equal(excludeReasonFor('Apple iPhone 13 128GB Unlocked'), null)
})

test('filterComps excludes comps missing a must token', () => {
  const comps = [
    { title: 'Apple iPhone 13 128GB', priceCents: 30000 },
    { title: 'Apple iPhone 12 128GB', priceCents: 22000 },
  ]
  const out = filterComps(comps, { mustTokens: ['iphone', '13'] })
  assert.equal(out[0].included, true)
  assert.equal(out[1].included, false)
  assert.equal(out[1].excludeReason, 'missing_token:13')
})

test('median handles odd and even lengths', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([]), null)
})

test('percentile uses linear interpolation', () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25)
  assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5)
})

test('iqrTrim removes values outside the 1.5x fence', () => {
  const vals = [100, 102, 104, 106, 108, 110, 5000]
  const r = iqrTrim(vals)
  assert.ok(!r.kept.includes(5000))
  assert.equal(r.kept.length, 6)
})

test('iqrTrim keeps everything when the sample is too small to fence', () => {
  const r = iqrTrim([100, 5000])
  assert.equal(r.kept.length, 2)
})

test('buildCompSet computes trimmed median, sell-through and velocity', () => {
  const now = 100 * DAY
  const sold = [
    { title: 'iPhone 13 128GB', priceCents: 30000, soldAt: now - 7 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 31000, soldAt: now - 14 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 29000, soldAt: now - 21 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 30500, soldAt: now - 28 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 29500, soldAt: now - 35 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 300000, soldAt: now - 40 * DAY },
    { title: 'Lot of 3 iPhone 13', priceCents: 80000, soldAt: now - 10 * DAY },
  ]
  const cs = buildCompSet({ soldComps: sold, activeCount: 100, mustTokens: ['iphone', '13'], now })
  assert.equal(cs.rawN, 7)
  assert.equal(cs.sampleN, 5)              // bundle excluded, 300000 outlier trimmed
  assert.equal(cs.trimmedMedianCents, 30000)
  assert.equal(cs.soldCount, 5)
  assert.ok(Math.abs(cs.sellThrough - 5 / 105) < 1e-9)
  assert.ok(cs.soldPerWeek > 0)
  assert.ok(cs.confidence > 0 && cs.confidence <= 1)
})

test('buildCompSet reports low confidence below the sample floor', () => {
  const now = 100 * DAY
  const cs = buildCompSet({
    soldComps: [{ title: 'iPhone 13', priceCents: 30000, soldAt: now - DAY }],
    activeCount: 10,
    mustTokens: ['iphone'],
    now,
    minSampleSize: 5,
  })
  assert.equal(cs.sampleN, 1)
  assert.equal(cs.lowConfidence, true)
  assert.ok(cs.confidence < 0.4)
})

test('buildCompSet with zero usable comps returns a null median, not a crash', () => {
  const cs = buildCompSet({ soldComps: [], activeCount: 0, mustTokens: ['x'], now: 1 })
  assert.equal(cs.trimmedMedianCents, null)
  assert.equal(cs.sampleN, 0)
  assert.equal(cs.confidence, 0)
  assert.equal(cs.sellThrough, 0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/stats.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/comps/stats.mjs**

```js
const DAY_MS = 86400000

const BUNDLE_RE = /\b(lot of|bundle|job lot|wholesale|\d+\s*x\s*(pack|units?)|pack of)\b/i
const PARTS_RE = /\b(for parts|parts only|not working|as-?is|spares? or repairs?)\b/i
const DAMAGED_RE = /\b(cracked|broken|damaged|read description|no power|water damage)\b/i

export function tokenize (s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
}

export function excludeReasonFor (title) {
  if (BUNDLE_RE.test(title)) return 'bundle'
  if (PARTS_RE.test(title)) return 'parts'
  if (DAMAGED_RE.test(title)) return 'damaged'
  return null
}

export function filterComps (comps, { mustTokens = [] } = {}) {
  return comps.map((c) => {
    const heuristic = excludeReasonFor(c.title)
    if (heuristic) return { ...c, included: false, excludeReason: heuristic }
    const toks = new Set(tokenize(c.title))
    const missing = mustTokens.find((t) => !toks.has(String(t).toLowerCase()))
    if (missing) return { ...c, included: false, excludeReason: `missing_token:${missing}` }
    return { ...c, included: true, excludeReason: null }
  })
}

export function median (values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function percentile (values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = (s.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

export function iqrTrim (values) {
  if (values.length < 4) return { kept: [...values], low: null, high: null }
  const q1 = percentile(values, 0.25)
  const q3 = percentile(values, 0.75)
  const iqr = q3 - q1
  const low = q1 - 1.5 * iqr
  const high = q3 + 1.5 * iqr
  return { kept: values.filter((v) => v >= low && v <= high), low, high }
}

/**
 * Sample size GATES the score, spread only modulates it. These must not be
 * independent additive terms: the spread across a single comp is trivially
 * zero, so an additive formula hands one lucky data point most of the spread
 * weight and reports high confidence on a sample of one.
 */
function confidenceFrom ({ sampleN, minSampleSize, p25, p75, med }) {
  if (!sampleN || med == null || med === 0) return 0
  const sizeScore = Math.min(1, sampleN / (minSampleSize * 2))
  const spread = (p75 - p25) / med
  const spreadScore = Math.max(0, 1 - Math.min(spread, 1))
  return Math.round(sizeScore * (0.6 + 0.4 * spreadScore) * 1000) / 1000
}

export function buildCompSet ({
  soldComps = [],
  activeCount = 0,
  mustTokens = [],
  now = Date.now(),
  minSampleSize = 5,
  marketplace = 'EBAY_US',
  identityKey = null,
  ttlHours = 168,
}) {
  const flagged = filterComps(soldComps, { mustTokens })
  const included = flagged.filter((c) => c.included)
  const prices = included.map((c) => c.priceCents)
  const trim = iqrTrim(prices)
  const keptSet = new Set()
  const kept = []
  for (const c of included) {
    if (trim.kept.includes(c.priceCents) && !keptSet.has(c)) {
      kept.push(c)
      keptSet.add(c)
    }
  }
  // Re-flag anything trimmed as an outlier so the audit trail is complete.
  const finalComps = flagged.map((c) =>
    c.included && !keptSet.has(c) ? { ...c, included: false, excludeReason: 'outlier' } : c
  )

  const keptPrices = kept.map((c) => c.priceCents)
  const med = median(keptPrices)
  const p25 = percentile(keptPrices, 0.25)
  const p75 = percentile(keptPrices, 0.75)
  const soldCount = kept.length

  const times = kept.map((c) => c.soldAt).filter((t) => typeof t === 'number')
  const spanDays = times.length > 1 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / DAY_MS) : null
  const soldPerWeek = spanDays ? (soldCount / spanDays) * 7 : null
  const soldPerDay = soldPerWeek ? soldPerWeek / 7 : null
  const daysOfSupply = soldPerDay && soldPerDay > 0 ? activeCount / soldPerDay : null

  const denom = soldCount + activeCount
  const sellThrough = denom > 0 ? soldCount / denom : 0

  return {
    identityKey,
    marketplace,
    trimmedMedianCents: med == null ? null : Math.round(med),
    p25Cents: p25 == null ? null : Math.round(p25),
    p75Cents: p75 == null ? null : Math.round(p75),
    sampleN: soldCount,
    rawN: soldComps.length,
    activeCount,
    soldCount,
    sellThrough,
    soldPerWeek,
    daysOfSupply,
    confidence: confidenceFrom({ sampleN: soldCount, minSampleSize, p25, p75, med }),
    lowConfidence: soldCount < minSampleSize,
    fetchedAt: now,
    expiresAt: now + ttlHours * 3600000,
    comps: finalComps,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/stats.test.mjs`
Expected: `# pass 10`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/comps/stats.mjs test/stats.test.mjs
git commit -m "feat: comp filtering, IQR trimming, sell-through and velocity"
```

---

## Task 7: Filters and Composite Scoring

**Files:**
- Create: `src/score/filters.mjs`, `src/score/rank.mjs`
- Test: `test/score.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/score.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters } from '../src/score/filters.mjs'
import { scoreDeal, saturate } from '../src/score/rank.mjs'
import { DEFAULTS } from '../src/config.mjs'

const good = {
  listing: { title: 'Apple iPhone 13 128GB unlocked', priceCents: 12000, sellerName: 'Jane', listedAt: Date.now() - 3600000 },
  identity: { identityConfidence: 0.9, category: 'phone' },
  compset: { sellThrough: 0.55, sampleN: 12, confidence: 0.8 },
  profit: { netCents: 11945, roi: 0.99, breakevenBuyCents: 23945, freight: false },
}

test('a good deal passes every filter', () => {
  const r = applyFilters(good, DEFAULTS)
  assert.equal(r.passed, true)
  assert.deepEqual(r.rejections, [])
})

test('low net profit is rejected with a named reason', () => {
  const r = applyFilters({ ...good, profit: { ...good.profit, netCents: 500 } }, DEFAULTS)
  assert.equal(r.passed, false)
  assert.equal(r.rejections[0].rule, 'min_net_profit')
  assert.match(r.rejections[0].reason, /\$5\.00/)
})

test('low sell-through is rejected', () => {
  const r = applyFilters({ ...good, compset: { ...good.compset, sellThrough: 0.1 } }, DEFAULTS)
  assert.equal(r.rejections[0].rule, 'min_sell_through')
})

test('every failing rule is reported, not just the first', () => {
  const bad = {
    ...good,
    profit: { ...good.profit, netCents: 100, roi: 0.01 },
    compset: { sellThrough: 0.05, sampleN: 1, confidence: 0.1 },
    identity: { identityConfidence: 0.2, category: 'phone' },
  }
  const r = applyFilters(bad, DEFAULTS)
  const rules = r.rejections.map((x) => x.rule).sort()
  assert.deepEqual(rules, ['min_comp_sample', 'min_identity_confidence', 'min_net_profit', 'min_roi', 'min_sell_through'])
})

test('freight is rejected when freight is disabled', () => {
  const r = applyFilters({ ...good, profit: { ...good.profit, freight: true, netCents: null } }, DEFAULTS)
  assert.ok(r.rejections.some((x) => x.rule === 'freight_disabled'))
})

test('freight passes when freight is enabled', () => {
  const cfg = { ...DEFAULTS, freight: { enabled: true } }
  const r = applyFilters({ ...good, profit: { ...good.profit, freight: true } }, cfg)
  assert.ok(!r.rejections.some((x) => x.rule === 'freight_disabled'))
})

test('a blacklisted keyword in the title is rejected', () => {
  const r = applyFilters({ ...good, listing: { ...good.listing, title: 'iPhone 13 for parts' } }, DEFAULTS)
  assert.equal(r.rejections[0].rule, 'blacklist_keyword')
})

test('a blacklisted seller is rejected', () => {
  const cfg = { ...DEFAULTS, blacklist: { ...DEFAULTS.blacklist, sellers: ['Jane'] } }
  const r = applyFilters(good, cfg)
  assert.ok(r.rejections.some((x) => x.rule === 'blacklist_seller'))
})

test('saturate is monotonic and bounded in 0..1', () => {
  assert.equal(saturate(0, 100), 0)
  assert.ok(saturate(100, 100) === 0.5)
  assert.ok(saturate(1e9, 100) < 1)
  assert.ok(saturate(50, 100) < saturate(150, 100))
})

test('scoreDeal is bounded and rewards profit', () => {
  const s1 = scoreDeal(good, DEFAULTS)
  const s2 = scoreDeal({ ...good, profit: { ...good.profit, netCents: 50000 } }, DEFAULTS)
  assert.ok(s1 >= 0 && s1 <= 1)
  assert.ok(s2 > s1)
})

test('a price drop increases the score', () => {
  const dropped = { ...good, priceDrop: { previousPriceCents: 20000, currentPriceCents: 12000 } }
  assert.ok(scoreDeal(dropped, DEFAULTS) > scoreDeal(good, DEFAULTS))
})

test('an older listing scores lower than a fresh one', () => {
  const old = { ...good, listing: { ...good.listing, listedAt: Date.now() - 14 * 86400000 } }
  assert.ok(scoreDeal(old, DEFAULTS) < scoreDeal(good, DEFAULTS))
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/score.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/score/filters.mjs**

```js
function money (cents) {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Every rule returns null to pass, or {rule, reason} to reject.
 * All rules run. Returning every reason is the point: `fbay deals --rejected`
 * has to explain exactly why anything was dropped.
 */
export function applyFilters ({ listing, identity, compset, profit }, config) {
  const t = config.thresholds
  const rejections = []

  if (profit.freight && !config.freight.enabled) {
    rejections.push({ rule: 'freight_disabled', reason: 'freight-class item and freight is disabled in config' })
  }

  if (!profit.freight) {
    if (profit.netCents == null || profit.netCents < t.minNetProfitCents) {
      rejections.push({ rule: 'min_net_profit', reason: `net ${money(profit.netCents ?? 0)} below floor ${money(t.minNetProfitCents)}` })
    }
    if (profit.roi != null && profit.roi < t.minRoi) {
      rejections.push({ rule: 'min_roi', reason: `roi ${profit.roi.toFixed(2)} below floor ${t.minRoi}` })
    }
  }

  if (compset.sellThrough < t.minSellThrough) {
    rejections.push({ rule: 'min_sell_through', reason: `sell-through ${(compset.sellThrough * 100).toFixed(0)}% below floor ${(t.minSellThrough * 100).toFixed(0)}%` })
  }

  if (compset.sampleN < t.minCompSampleSize) {
    rejections.push({ rule: 'min_comp_sample', reason: `only ${compset.sampleN} usable comps, need ${t.minCompSampleSize}` })
  }

  if (identity.identityConfidence < t.minIdentityConfidence) {
    rejections.push({ rule: 'min_identity_confidence', reason: `identity confidence ${identity.identityConfidence} below floor ${t.minIdentityConfidence}` })
  }

  if (listing.priceCents > t.maxAskCents) {
    rejections.push({ rule: 'max_ask', reason: `ask ${money(listing.priceCents)} above ceiling ${money(t.maxAskCents)}` })
  }

  const title = String(listing.title).toLowerCase()
  const kw = (config.blacklist?.keywords ?? []).find((k) => title.includes(k.toLowerCase()))
  if (kw) rejections.push({ rule: 'blacklist_keyword', reason: `title contains blacklisted keyword "${kw}"` })

  const seller = listing.sellerName
  if (seller && (config.blacklist?.sellers ?? []).some((s) => s.toLowerCase() === seller.toLowerCase())) {
    rejections.push({ rule: 'blacklist_seller', reason: `seller "${seller}" is blacklisted` })
  }

  return { passed: rejections.length === 0, rejections }
}
```

- [ ] **Step 4: Implement src/score/rank.mjs**

```js
/** Bounded, monotonic normaliser. saturate(half, half) === 0.5 by construction. */
export function saturate (value, half) {
  const v = Math.max(0, value)
  return v / (v + half)
}

const PROFIT_HALF_CENTS = 10000   // $100 net scores 0.5 on the profit axis
const ROI_HALF = 1.0              // 100% ROI scores 0.5 on the roi axis
const AGE_HALF_HOURS = 24         // 24h old scores 0.5 on the age penalty axis

export function scoreDeal ({ listing, identity, compset, profit, priceDrop }, config, now = Date.now()) {
  const w = config.weights

  const profitScore = saturate(profit.netCents ?? 0, PROFIT_HALF_CENTS)
  const roiScore = saturate(profit.roi ?? 0, ROI_HALF)
  const velocityScore = Math.min(1, Math.max(0, compset.sellThrough))
  const confidenceScore = Math.min(1, Math.max(0, identity.identityConfidence * compset.confidence))

  const hours = listing.listedAt ? Math.max(0, (now - listing.listedAt) / 3600000) : AGE_HALF_HOURS
  const agePenalty = saturate(hours, AGE_HALF_HOURS)

  let dropScore = 0
  if (priceDrop?.previousPriceCents > 0 && priceDrop.currentPriceCents >= 0) {
    dropScore = Math.min(1, Math.max(0, 1 - priceDrop.currentPriceCents / priceDrop.previousPriceCents))
  }

  const raw =
    w.profit * profitScore +
    w.roi * roiScore +
    w.velocity * velocityScore +
    w.confidence * confidenceScore +
    w.drop * dropScore -
    w.age * agePenalty

  const maxPossible = w.profit + w.roi + w.velocity + w.confidence + w.drop
  return Math.min(1, Math.max(0, raw / maxPossible))
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/score.test.mjs`
Expected: `# pass 12`, `# fail 0`

- [ ] **Step 6: Run the whole suite and commit**

```bash
node --test test/*.test.mjs
git add src/score test/score.test.mjs
git commit -m "feat: hard filters with recorded reasons and composite deal scoring"
```

**Phase 1 complete.** The money math is fully tested with zero network dependencies.

---
## Task 8: eBay Browse API Client (Active Listings)

**Files:**
- Create: `src/comps/ebay-browse.mjs`
- Test: `test/ebay-browse.test.mjs`

The Browse API supplies the **active listing count** used for sell-through. It does not supply sold prices. Do not use active prices for valuation.

- [ ] **Step 1: Write the failing test**

Create `test/ebay-browse.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowseClient, parseBrowseResponse } from '../src/comps/ebay-browse.mjs'

function fakeFetch (responses) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts })
    const r = responses.shift()
    if (!r) throw new Error('unexpected fetch')
    return {
      ok: r.status === undefined ? true : r.status < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    }
  }
  fn.calls = calls
  return fn
}

const TOKEN_RES = { body: { access_token: 'tok123', expires_in: 7200 } }

test('parseBrowseResponse maps items to cents and drops malformed rows', () => {
  const out = parseBrowseResponse({
    total: 412,
    itemSummaries: [
      { itemId: 'v1|1|0', title: 'iPhone 13', price: { value: '299.99', currency: 'USD' }, condition: 'Used', itemWebUrl: 'https://x' },
      { itemId: 'v1|2|0', title: 'no price' },
    ],
  })
  assert.equal(out.total, 412)
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].priceCents, 29999)
})

test('token is requested once and reused until expiry', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 1, itemSummaries: [] } }, { body: { total: 2, itemSummaries: [] } }])
  let t = 0
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => t })
  await c.searchActive('x')
  t = 1000
  await c.searchActive('y')
  const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('oauth2/token'))
  assert.equal(tokenCalls.length, 1)
})

test('token is re-requested after expiry', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 1, itemSummaries: [] } }, TOKEN_RES, { body: { total: 1, itemSummaries: [] } }])
  let t = 0
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => t })
  await c.searchActive('x')
  t = 8000 * 1000
  await c.searchActive('y')
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('oauth2/token')).length, 2)
})

test('token request uses HTTP Basic with base64 appId:certId', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 0, itemSummaries: [] } }])
  const c = createBrowseClient({ appId: 'APP', certId: 'CERT', fetchImpl, clock: () => 0 })
  await c.searchActive('x')
  const auth = fetchImpl.calls[0].opts.headers.Authorization
  assert.equal(auth, 'Basic ' + Buffer.from('APP:CERT').toString('base64'))
})

test('search sends the marketplace header and encodes the query', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 0, itemSummaries: [] } }])
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => 0, marketplace: 'EBAY_US' })
  await c.searchActive('iphone 13 128gb')
  const call = fetchImpl.calls[1]
  assert.match(call.url, /q=iphone\+13\+128gb/)   // URLSearchParams encodes spaces as +
  assert.equal(call.opts.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US')
})

test('an API error returns ok:false rather than throwing', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { status: 500, body: { error: 'boom' } }])
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => 0, retries: 0 })
  const r = await c.searchActive('x')
  assert.equal(r.ok, false)
  assert.match(r.error, /500/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/ebay-browse.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/comps/ebay-browse.mjs**

```js
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
const SCOPE = 'https://api.ebay.com/oauth/api_scope'

export function toCents (value) {
  if (value == null) return null
  const n = Number(String(value).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function parseBrowseResponse (body) {
  const items = (body.itemSummaries ?? [])
    .map((it) => ({
      ebayItemId: it.itemId,
      title: it.title,
      priceCents: toCents(it.price?.value),
      condition: it.condition ?? null,
      url: it.itemWebUrl ?? null,
    }))
    .filter((it) => it.title && it.priceCents != null)
  return { total: body.total ?? items.length, items }
}

export function createBrowseClient ({
  appId,
  certId,
  marketplace = 'EBAY_US',
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let token = null
  let tokenExpiresAt = 0

  async function getToken () {
    if (token && clock() < tokenExpiresAt) return { ok: true, token }
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${appId}:${certId}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    })
    if (!res.ok) return { ok: false, error: `eBay token request failed: ${res.status}` }
    const body = await res.json()
    token = body.access_token
    // Refresh 60s early so a request never races the expiry boundary.
    tokenExpiresAt = clock() + (body.expires_in - 60) * 1000
    return { ok: true, token }
  }

  async function searchActive (query, { limit = 200, categoryId, filter } = {}) {
    const t = await getToken()
    if (!t.ok) return t

    const params = new URLSearchParams({ q: query, limit: String(Math.min(limit, 200)) })
    if (categoryId) params.set('category_ids', categoryId)
    if (filter) params.set('filter', filter)

    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetchImpl(`${SEARCH_URL}?${params}`, {
        headers: {
          Authorization: `Bearer ${t.token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplace,
          Accept: 'application/json',
        },
      })
      if (res.ok) return { ok: true, ...parseBrowseResponse(await res.json()) }
      lastError = `eBay Browse search failed: ${res.status}`
      if (res.status < 500) break
      await sleepImpl(300 * 2 ** attempt)
    }
    return { ok: false, error: lastError }
  }

  return { getToken, searchActive }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/ebay-browse.test.mjs`
Expected: `# pass 6`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/comps/ebay-browse.mjs test/ebay-browse.test.mjs
git commit -m "feat: eBay Browse API client with token caching and bounded retries"
```

---

## Task 9: eBay Sold-Listing Fetch and Multi-Strategy Parser

**Files:**
- Create: `src/comps/ebay-sold.mjs`, `test/fixtures/ebay-sold-iphone.html`
- Test: `test/ebay-sold.test.mjs`

eBay rewrites its search markup periodically. The parser therefore tries an ordered list of selector strategies and uses the first that yields results, reporting which one worked. A canary later asserts that a known query still returns results, so drift becomes an alert instead of silence.

- [ ] **Step 1: Capture a live fixture**

Run:

```bash
mkdir -p test/fixtures
curl -sL -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' \
  'https://www.ebay.com/sch/i.html?_nkw=iphone+13+128gb+unlocked&LH_Sold=1&LH_Complete=1&_ipg=60' \
  -o test/fixtures/ebay-sold-iphone.html
wc -c test/fixtures/ebay-sold-iphone.html
```

Expected: a file well over 200 KB. If it is under 50 KB, eBay returned a challenge page. Retry, or save the page from a real browser via `Cmd+S` into the same path.

- [ ] **Step 2: Inspect which container class the fixture actually uses**

Run:

```bash
grep -o 'class="[^"]*s-card[^"]*"' test/fixtures/ebay-sold-iphone.html | head -3
grep -o 'class="[^"]*s-item[^"]*"' test/fixtures/ebay-sold-iphone.html | head -3
```

Expected: at least one of the two prints matches. Whichever matches is the strategy that must succeed in the test below. Both strategies stay in the code so the parser survives eBay switching back.

- [ ] **Step 3: Write the failing test**

Create `test/ebay-sold.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseSoldHtml, parsePriceCents, parseSoldDate, soldSearchUrl, createSoldClient } from '../src/comps/ebay-sold.mjs'

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/ebay-sold-iphone.html'), 'utf8')

test('parsePriceCents handles plain, comma and range prices', () => {
  assert.equal(parsePriceCents('$299.99'), 29999)
  assert.equal(parsePriceCents('$1,234.56'), 123456)
  assert.equal(parsePriceCents('$10.00 to $20.00'), 1000)  // low end of a range
  assert.equal(parsePriceCents('C $50.00'), 5000)
  assert.equal(parsePriceCents('nonsense'), null)
})

test('parseSoldDate extracts a timestamp from eBay caption text', () => {
  const ts = parseSoldDate('Sold  Jan 5, 2026')
  assert.equal(new Date(ts).getUTCFullYear(), 2026)
  assert.equal(new Date(ts).getUTCMonth(), 0)
  assert.equal(parseSoldDate('no date here'), null)
})

test('soldSearchUrl sets the sold and completed filters', () => {
  const u = soldSearchUrl('iphone 13 128gb')
  assert.match(u, /LH_Sold=1/)
  assert.match(u, /LH_Complete=1/)
  assert.match(u, /_nkw=iphone\+13\+128gb/)
})

test('parseSoldHtml extracts real comps from the live fixture', () => {
  const r = parseSoldHtml(FIXTURE)
  assert.ok(r.strategy, 'no selector strategy matched the fixture')
  assert.ok(r.comps.length >= 10, `expected 10+ comps, got ${r.comps.length}`)
  for (const c of r.comps) {
    assert.ok(c.title.length > 3)
    assert.ok(Number.isInteger(c.priceCents) && c.priceCents > 0)
  }
})

test('parseSoldHtml drops the "Shop on eBay" placeholder row', () => {
  const r = parseSoldHtml(FIXTURE)
  assert.ok(!r.comps.some((c) => /shop on ebay/i.test(c.title)))
})

test('parseSoldHtml on unrecognised markup returns an empty result with a null strategy', () => {
  const r = parseSoldHtml('<html><body><div>nothing here</div></body></html>')
  assert.equal(r.strategy, null)
  assert.deepEqual(r.comps, [])
})

test('createSoldClient returns ok:false on a non-200 rather than throwing', async () => {
  const client = createSoldClient({ fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }), retries: 0 })
  const r = await client.fetchSold('x')
  assert.equal(r.ok, false)
  assert.match(r.error, /429/)
})

test('createSoldClient parses a successful response', async () => {
  const client = createSoldClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => FIXTURE }) })
  const r = await client.fetchSold('iphone 13')
  assert.equal(r.ok, true)
  assert.ok(r.comps.length >= 10)
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `node --test test/ebay-sold.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 5: Implement src/comps/ebay-sold.mjs**

```js
import * as cheerio from 'cheerio'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Ordered selector strategies. The first that yields results wins.
// eBay has shipped both of these shapes; keeping both means a rollback on their
// side does not become an outage on ours.
export const SELECTOR_STRATEGIES = [
  {
    name: 's-card',
    root: '.s-card',
    title: '.s-card__title, .su-styled-text.primary',
    price: '.s-card__price, .su-styled-text.bold',
    caption: '.s-card__caption, .su-styled-text.secondary',
    link: 'a.su-link, a',
  },
  {
    name: 's-item',
    root: 'li.s-item, .s-item__wrapper',
    title: '.s-item__title',
    price: '.s-item__price',
    caption: '.s-item__caption, .s-item__title--tagblock',
    link: 'a.s-item__link, a',
  },
]

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

export function parsePriceCents (text) {
  if (!text) return null
  const first = String(text).split(/\s+to\s+/i)[0]
  const m = first.match(/([\d,]+\.?\d*)/)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function parseSoldDate (text) {
  if (!text) return null
  const m = String(text).match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (month === undefined) return null
  return Date.UTC(Number(m[3]), month, Number(m[2]))
}

export function soldSearchUrl (query, { perPage = 240 } = {}) {
  const p = new URLSearchParams({ _nkw: query, LH_Sold: '1', LH_Complete: '1', _ipg: String(perPage) })
  return `https://www.ebay.com/sch/i.html?${p}`
}

function extractItemId (href) {
  const m = String(href || '').match(/\/itm\/(?:.*\/)?(\d{9,})/)
  return m ? m[1] : null
}

const PLACEHOLDER_RE = /^(shop on ebay|results matching fewer words|new listing)$/i

export function parseSoldHtml (html) {
  const $ = cheerio.load(html)
  for (const s of SELECTOR_STRATEGIES) {
    const comps = []
    $(s.root).each((_, el) => {
      const node = $(el)
      const title = node.find(s.title).first().text().trim().replace(/^New Listing/i, '').trim()
      const priceCents = parsePriceCents(node.find(s.price).first().text())
      if (!title || PLACEHOLDER_RE.test(title) || priceCents == null) return
      const href = node.find(s.link).first().attr('href') ?? null
      const captionText = node.find(s.caption).map((_i, c) => $(c).text()).get().join(' ')
      comps.push({
        ebayItemId: extractItemId(href),
        title,
        priceCents,
        soldAt: parseSoldDate(captionText),
        url: href,
        condition: null,
      })
    })
    // Deduplicate: eBay renders the same item in both a card and a hidden wrapper.
    const seen = new Set()
    const unique = comps.filter((c) => {
      const key = c.ebayItemId ?? `${c.title}|${c.priceCents}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (unique.length > 0) return { strategy: s.name, comps: unique }
  }
  return { strategy: null, comps: [] }
}

export function createSoldClient ({
  fetchImpl = globalThis.fetch,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  async function fetchSold (query, opts = {}) {
    const url = soldSearchUrl(query, opts)
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      })
      if (res.ok) {
        const { strategy, comps } = parseSoldHtml(await res.text())
        return { ok: true, strategy, comps, url }
      }
      lastError = `eBay sold fetch failed: ${res.status}`
      await sleepImpl(500 * 2 ** attempt)
    }
    return { ok: false, error: lastError, url }
  }
  return { fetchSold }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test test/ebay-sold.test.mjs`
Expected: `# pass 8`, `# fail 0`

If `parseSoldHtml extracts real comps` fails, the fixture is a challenge page rather than results. Re-capture it from a real browser. Do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add src/comps/ebay-sold.mjs test/ebay-sold.test.mjs test/fixtures/ebay-sold-iphone.html
git commit -m "feat: eBay sold-listing client with multi-strategy drift-resistant parser"
```

---

## Task 10: CompSet Assembly, Caching and the `fbay comps` Command

**Files:**
- Create: `src/comps/index.mjs`, `src/cli.mjs`, `fbay`
- Test: `test/comps-index.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/comps-index.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'
import { getCompSet } from '../src/comps/index.mjs'
import { DEFAULTS } from '../src/config.mjs'

const DAY = 86400000
const identity = { identityKey: 'k1', query: 'apple iphone 13 128gb', mustTokens: ['iphone', '13'], category: 'phone' }

function fakeSold (comps) {
  return { fetchSold: async () => ({ ok: true, strategy: 's-card', comps }) }
}
function fakeBrowse (total) {
  return { searchActive: async () => ({ ok: true, total, items: [] }) }
}

const SOLD = Array.from({ length: 8 }, (_, i) => ({
  title: 'Apple iPhone 13 128GB Unlocked',
  priceCents: 29000 + i * 200,
  soldAt: 100 * DAY - i * 3 * DAY,
}))

test('getCompSet fetches, computes and persists on a cache miss', async () => {
  const repo = createRepo(openDb(':memory:'))
  const r = await getCompSet({ identity, repo, sold: fakeSold(SOLD), browse: fakeBrowse(120), config: DEFAULTS, now: 100 * DAY })
  assert.equal(r.ok, true)
  assert.equal(r.cached, false)
  assert.equal(r.compset.sampleN, 8)
  assert.ok(r.compset.trimmedMedianCents > 29000)
  assert.equal(r.compset.activeCount, 120)
  assert.ok(repo.getFreshCompSet('k1', 100 * DAY))
})

test('a second call within TTL is served from cache without any fetch', async () => {
  const repo = createRepo(openDb(':memory:'))
  let soldCalls = 0
  const sold = { fetchSold: async () => { soldCalls++; return { ok: true, strategy: 's-card', comps: SOLD } } }
  await getCompSet({ identity, repo, sold, browse: fakeBrowse(120), config: DEFAULTS, now: 100 * DAY })
  const second = await getCompSet({ identity, repo, sold, browse: fakeBrowse(120), config: DEFAULTS, now: 100 * DAY + 3600000 })
  assert.equal(soldCalls, 1)
  assert.equal(second.cached, true)
  assert.equal(second.compset.sampleN, 8)
})

test('an expired cache entry triggers a refetch', async () => {
  const repo = createRepo(openDb(':memory:'))
  let soldCalls = 0
  const sold = { fetchSold: async () => { soldCalls++; return { ok: true, strategy: 's-card', comps: SOLD } } }
  await getCompSet({ identity, repo, sold, browse: fakeBrowse(120), config: DEFAULTS, now: 100 * DAY })
  await getCompSet({ identity, repo, sold, browse: fakeBrowse(120), config: DEFAULTS, now: 100 * DAY + 200 * 3600000 })
  assert.equal(soldCalls, 2)
})

test('a sold-fetch failure returns ok:false and persists nothing', async () => {
  const repo = createRepo(openDb(':memory:'))
  const sold = { fetchSold: async () => ({ ok: false, error: 'boom' }) }
  const r = await getCompSet({ identity, repo, sold, browse: fakeBrowse(10), config: DEFAULTS, now: 1 })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
  assert.equal(repo.getFreshCompSet('k1', 1), undefined)
})

test('a browse failure degrades to activeCount 0 rather than failing the whole compset', async () => {
  const repo = createRepo(openDb(':memory:'))
  const browse = { searchActive: async () => ({ ok: false, error: 'rate limited' }) }
  const r = await getCompSet({ identity, repo, sold: fakeSold(SOLD), browse, config: DEFAULTS, now: 100 * DAY })
  assert.equal(r.ok, true)
  assert.equal(r.compset.activeCount, 0)
  assert.equal(r.compset.sellThrough, 1)
  assert.ok(r.warnings.some((w) => /rate limited/.test(w)))
})

test('backing comps are persisted with their exclusion reasons', async () => {
  const repo = createRepo(openDb(':memory:'))
  const withJunk = [...SOLD, { title: 'Lot of 4 iPhone 13', priceCents: 99000, soldAt: 100 * DAY }]
  const r = await getCompSet({ identity, repo, sold: fakeSold(withJunk), browse: fakeBrowse(50), config: DEFAULTS, now: 100 * DAY })
  const rows = repo.compsFor(r.compsetId)
  assert.equal(rows.length, 9)
  assert.equal(rows.find((x) => /Lot of 4/.test(x.title)).exclude_reason, 'bundle')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/comps-index.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/comps/index.mjs**

```js
import { buildCompSet } from './stats.mjs'

function rowToCompSet (row, minSampleSize) {
  return {
    identityKey: row.identity_key,
    marketplace: row.marketplace,
    trimmedMedianCents: row.trimmed_median_cents,
    p25Cents: row.p25_cents,
    p75Cents: row.p75_cents,
    sampleN: row.sample_n,
    rawN: row.raw_n,
    activeCount: row.active_count,
    soldCount: row.sold_count,
    sellThrough: row.sell_through,
    soldPerWeek: row.sold_per_week,
    daysOfSupply: row.days_of_supply,
    confidence: row.confidence,
    lowConfidence: row.sample_n < minSampleSize,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  }
}

/**
 * Returns {ok, compset, compsetId, cached, warnings}.
 * Sold data is required. Active data is best-effort: losing it costs us the
 * sell-through signal, not the valuation, so it degrades instead of failing.
 */
export async function getCompSet ({ identity, repo, sold, browse, config, now = Date.now() }) {
  const cachedRow = repo.getFreshCompSet(identity.identityKey, now)
  if (cachedRow) {
    return { ok: true, cached: true, compset: rowToCompSet(cachedRow, config.thresholds.minCompSampleSize), compsetId: cachedRow.id, warnings: [] }
  }

  const warnings = []
  const soldRes = await sold.fetchSold(identity.query)
  if (!soldRes.ok) return { ok: false, error: `sold comps unavailable: ${soldRes.error}`, warnings }
  if (!soldRes.strategy) {
    return { ok: false, error: 'eBay sold parser matched no selector strategy (possible markup drift)', warnings }
  }

  let activeCount = 0
  const browseRes = await browse.searchActive(identity.query)
  if (browseRes.ok) activeCount = browseRes.total
  else warnings.push(`active-listing count unavailable: ${browseRes.error}`)

  const built = buildCompSet({
    soldComps: soldRes.comps,
    activeCount,
    mustTokens: identity.mustTokens,
    now,
    minSampleSize: config.thresholds.minCompSampleSize,
    marketplace: config.marketplace,
    identityKey: identity.identityKey,
    ttlHours: config.compsTtlHours,
  })

  const { comps, ...persistable } = built
  const { id } = repo.saveCompSet(persistable, comps)
  return { ok: true, cached: false, compset: built, compsetId: id, warnings }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/comps-index.test.mjs`
Expected: `# pass 6`, `# fail 0`

- [ ] **Step 5: Create the CLI skeleton with the `comps` command**

Create `src/cli.mjs`:

```js
#!/usr/bin/env node
import 'dotenv/config'
import { loadConfig, requireEnv } from './config.mjs'
import { openDb } from './db/db.mjs'
import { createRepo } from './db/repo.mjs'
import { createBrowseClient } from './comps/ebay-browse.mjs'
import { createSoldClient } from './comps/ebay-sold.mjs'
import { getCompSet } from './comps/index.mjs'

export function money (cents) {
  if (cents == null) return 'n/a'
  return `$${(cents / 100).toFixed(2)}`
}

export function pct (x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`
}

function buildContext () {
  const config = loadConfig()
  const repo = createRepo(openDb())
  const browse = createBrowseClient({
    appId: process.env.EBAY_APP_ID,
    certId: process.env.EBAY_CERT_ID,
    marketplace: config.marketplace,
  })
  const sold = createSoldClient()
  return { config, repo, browse, sold }
}

const COMMANDS = {
  async comps (args) {
    const query = args.join(' ')
    if (!query) {
      console.error('usage: fbay comps "<search query>"')
      process.exitCode = 1
      return
    }
    const env = requireEnv(process.env, ['EBAY_APP_ID', 'EBAY_CERT_ID'])
    if (!env.ok) console.warn(`warning: missing ${env.missing.join(', ')} - active counts will be unavailable`)

    const { config, repo, browse, sold } = buildContext()
    const identity = {
      identityKey: `adhoc:${query.toLowerCase()}`,
      query,
      mustTokens: [],
      category: 'other',
    }
    const r = await getCompSet({ identity, repo, sold, browse, config })
    if (!r.ok) {
      console.error(`failed: ${r.error}`)
      process.exitCode = 1
      return
    }
    const c = r.compset
    for (const w of r.warnings) console.warn(`warning: ${w}`)
    console.log(`\n  ${query}${r.cached ? '  (cached)' : ''}\n`)
    console.log(`  median sold   ${money(c.trimmedMedianCents)}`)
    console.log(`  range         ${money(c.p25Cents)} - ${money(c.p75Cents)}`)
    console.log(`  comps used    ${c.sampleN} of ${c.rawN}`)
    console.log(`  active now    ${c.activeCount}`)
    console.log(`  sell-through  ${pct(c.sellThrough)}`)
    console.log(`  velocity      ${c.soldPerWeek ? c.soldPerWeek.toFixed(1) + '/week' : 'n/a'}`)
    console.log(`  confidence    ${pct(c.confidence)}${c.lowConfidence ? '  (low sample)' : ''}\n`)
  },

  async stats () {
    const { repo } = buildContext()
    console.table(repo.stats())
  },
}

async function main () {
  const [cmd, ...args] = process.argv.slice(2)
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.log(`fbay - Facebook Marketplace to eBay arbitrage\n\ncommands:\n  ${Object.keys(COMMANDS).join('\n  ')}`)
    process.exitCode = cmd ? 1 : 0
    return
  }
  await fn(args)
}

main().catch((e) => {
  console.error(e.stack ?? String(e))
  process.exitCode = 1
})
```

Create `fbay`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node src/cli.mjs "$@"
```

- [ ] **Step 6: Make it executable and verify end to end against live eBay**

Run:

```bash
chmod +x fbay src/cli.mjs
cp -n .env.example .env || true
./fbay comps "iphone 13 128gb unlocked"
```

Expected: a block showing a median sold price in a plausible range for a used iPhone 13 (roughly $150 to $400), a comp count above 10, and an active count above 100. If `EBAY_APP_ID` is not yet set, the active count will be 0 with a printed warning, which is the correct degraded behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/comps/index.mjs src/cli.mjs fbay test/comps-index.test.mjs
git commit -m "feat: cached compset assembly and the fbay comps command"
```

**Phase 2 complete.** `fbay comps "<anything>"` answers what an item sells for and how fast.

---

## Task 11: Request Pacing and Budgets

**Files:**
- Create: `src/source/facebook/pace.mjs`
- Test: `test/pace.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/pace.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPacer, PaceLimitError } from '../src/source/facebook/pace.mjs'
import { DEFAULTS } from '../src/config.mjs'

function harness (overrides = {}) {
  let t = 0
  const slept = []
  const pacer = createPacer({
    config: { ...DEFAULTS.pace, ...overrides },
    clock: () => t,
    sleepImpl: async (ms) => { slept.push(ms); t += ms },
    rng: () => 0.5,
  })
  return { pacer, slept, advance: (ms) => { t += ms }, now: () => t }
}

test('delay is drawn inside the configured bounds', () => {
  const { pacer } = harness({ minDelayMs: 1000, maxDelayMs: 3000 })
  for (const r of [0, 0.25, 0.5, 0.99, 1]) {
    const d = pacer.nextDelayMs(r)
    assert.ok(d >= 1000 && d <= 3000, `delay ${d} out of bounds`)
  }
})

test('delay is not a constant across different random draws', () => {
  const { pacer } = harness({ minDelayMs: 1000, maxDelayMs: 5000 })
  assert.notEqual(pacer.nextDelayMs(0.1), pacer.nextDelayMs(0.9))
})

test('beforeRequest sleeps between calls', async () => {
  const { pacer, slept } = harness()
  await pacer.beforeRequest()
  await pacer.beforeRequest()
  assert.equal(slept.length, 1)  // no sleep before the very first request
  assert.ok(slept[0] > 0)
})

test('the hourly request ceiling throws PaceLimitError', async () => {
  const { pacer } = harness({ maxRequestsPerHour: 2, minDelayMs: 1, maxDelayMs: 1 })
  await pacer.beforeRequest()
  await pacer.beforeRequest()
  await assert.rejects(() => pacer.beforeRequest(), PaceLimitError)
})

test('the hourly window rolls forward', async () => {
  const { pacer, advance } = harness({ maxRequestsPerHour: 2, minDelayMs: 1, maxDelayMs: 1 })
  await pacer.beforeRequest()
  await pacer.beforeRequest()
  advance(3600001)
  await pacer.beforeRequest()
  assert.equal(pacer.stats().requestsThisHour, 1)
})

test('the daily listing budget is enforced', () => {
  const { pacer } = harness({ maxListingsPerDay: 5 })
  pacer.countListings(4)
  assert.equal(pacer.listingBudgetRemaining(), 1)
  pacer.countListings(1)
  assert.equal(pacer.listingBudgetRemaining(), 0)
  assert.equal(pacer.listingBudgetExhausted(), true)
})

test('recordBlock sets a cooldown that blocks further requests', async () => {
  const { pacer, advance } = harness({ minDelayMs: 1, maxDelayMs: 1 })
  pacer.recordBlock('checkpoint')
  assert.equal(pacer.isCoolingDown(), true)
  await assert.rejects(() => pacer.beforeRequest(), PaceLimitError)
  advance(pacer.stats().cooldownMs + 1)
  assert.equal(pacer.isCoolingDown(), false)
})

test('consecutive blocks lengthen the cooldown', () => {
  const { pacer } = harness()
  pacer.recordBlock('checkpoint')
  const first = pacer.stats().cooldownMs
  pacer.recordBlock('checkpoint')
  assert.ok(pacer.stats().cooldownMs > first)
})

test('shouldFetchDetail respects the configured ratio deterministically', () => {
  const { pacer } = harness({ detailFetchRatio: 0.35 })
  assert.equal(pacer.shouldFetchDetail(0.2), true)
  assert.equal(pacer.shouldFetchDetail(0.9), false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pace.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/source/facebook/pace.mjs**

```js
export class PaceLimitError extends Error {
  constructor (message, kind) {
    super(message)
    this.name = 'PaceLimitError'
    this.kind = kind
  }
}

const HOUR_MS = 3600000
const BASE_COOLDOWN_MS = 15 * 60000

export function createPacer ({
  config,
  clock = Date.now,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  rng = Math.random,
}) {
  let requestTimes = []
  let listingsCounted = 0
  let lastRequestAt = null
  let blockCount = 0
  let cooldownUntil = 0

  function pruneWindow () {
    const cutoff = clock() - HOUR_MS
    requestTimes = requestTimes.filter((t) => t > cutoff)
  }

  function cooldownMs () {
    return BASE_COOLDOWN_MS * 2 ** Math.max(0, blockCount - 1)
  }

  /**
   * Skewed toward the short end so the traffic looks like scrolling rather than
   * a metronome, but with a long tail so the pattern is not periodic.
   */
  function nextDelayMs (r = rng()) {
    const { minDelayMs, maxDelayMs } = config
    const skewed = r ** 1.7
    return Math.round(minDelayMs + skewed * (maxDelayMs - minDelayMs))
  }

  return {
    nextDelayMs,

    async beforeRequest () {
      if (clock() < cooldownUntil) {
        throw new PaceLimitError(`cooling down for ${Math.ceil((cooldownUntil - clock()) / 1000)}s after a block`, 'cooldown')
      }
      pruneWindow()
      if (requestTimes.length >= config.maxRequestsPerHour) {
        throw new PaceLimitError(`hourly request ceiling of ${config.maxRequestsPerHour} reached`, 'hourly')
      }
      if (lastRequestAt !== null) await sleepImpl(nextDelayMs())
      lastRequestAt = clock()
      requestTimes.push(lastRequestAt)
    },

    countListings (n) { listingsCounted += n },
    listingBudgetRemaining () { return Math.max(0, config.maxListingsPerDay - listingsCounted) },
    listingBudgetExhausted () { return listingsCounted >= config.maxListingsPerDay },

    shouldFetchDetail (r = rng()) { return r < config.detailFetchRatio },

    recordBlock (kind) {
      blockCount += 1
      cooldownUntil = clock() + cooldownMs()
      return { kind, blockCount, cooldownUntil }
    },

    clearBlocks () { blockCount = 0; cooldownUntil = 0 },
    isCoolingDown () { return clock() < cooldownUntil },

    stats () {
      pruneWindow()
      return {
        requestsThisHour: requestTimes.length,
        listingsCounted,
        listingBudgetRemaining: Math.max(0, config.maxListingsPerDay - listingsCounted),
        blockCount,
        cooldownUntil,
        cooldownMs: cooldownMs(),
      }
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pace.test.mjs`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/source/facebook/pace.mjs test/pace.test.mjs
git commit -m "feat: request pacing with hourly ceilings, daily budgets and block cooldowns"
```

---

## Task 12: Marketplace Search URL Construction

**Files:**
- Create: `src/source/facebook/search.mjs`
- Test: `test/fb-search.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/fb-search.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchUrl, SORT_OPTIONS } from '../src/source/facebook/search.mjs'

test('builds a search URL with the city slug in the path', () => {
  const u = buildSearchUrl({ city: 'nyc', query: 'macbook pro' })
  assert.ok(u.startsWith('https://www.facebook.com/marketplace/nyc/search'))
  assert.match(u, /query=macbook\+pro/)
})

test('price bounds are sent in whole dollars, not cents', () => {
  const u = buildSearchUrl({ city: 'nyc', query: 'x', minPriceCents: 5000, maxPriceCents: 120000 })
  assert.match(u, /minPrice=50\b/)
  assert.match(u, /maxPrice=1200\b/)
})

test('radius is included and defaults to 40km', () => {
  assert.match(buildSearchUrl({ city: 'nyc', query: 'x' }), /radius=40/)
  assert.match(buildSearchUrl({ city: 'nyc', query: 'x', radiusKm: 100 }), /radius=100/)
})

test('newest-first is the default sort', () => {
  assert.match(buildSearchUrl({ city: 'nyc', query: 'x' }), /sortBy=creation_time_descend/)
})

test('an unknown sort falls back to the default instead of producing a broken URL', () => {
  const u = buildSearchUrl({ city: 'nyc', query: 'x', sort: 'not_a_sort' })
  assert.match(u, new RegExp(`sortBy=${SORT_OPTIONS.default}`))
})

test('a category watch uses the category path and omits the query param', () => {
  const u = buildSearchUrl({ city: 'nyc', category: 'electronics' })
  assert.ok(u.includes('/marketplace/nyc/electronics'))
  assert.ok(!u.includes('query='))
})

test('city slugs are normalised', () => {
  assert.ok(buildSearchUrl({ city: 'New York City', query: 'x' }).includes('/marketplace/newyorkcity/'))
})

test('a missing city throws, because a silent global search would waste the whole budget', () => {
  assert.throws(() => buildSearchUrl({ query: 'x' }), /city/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/fb-search.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/source/facebook/search.mjs**

```js
export const SORT_OPTIONS = {
  default: 'creation_time_descend',
  newest: 'creation_time_descend',
  price_asc: 'price_ascend',
  price_desc: 'price_descend',
  distance: 'distance_ascend',
  best_match: 'best_match',
}

const VALID_SORTS = new Set(Object.values(SORT_OPTIONS))

export function citySlug (city) {
  return String(city).toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function buildSearchUrl ({ city, query, category, minPriceCents, maxPriceCents, radiusKm = 40, sort }) {
  if (!city) throw new Error('buildSearchUrl requires a city; a location-less search would burn the request budget')

  const slug = citySlug(city)
  const sortBy = VALID_SORTS.has(sort) ? sort : SORT_OPTIONS.default

  const params = new URLSearchParams()
  if (!category && query) params.set('query', query)
  if (minPriceCents != null) params.set('minPrice', String(Math.floor(minPriceCents / 100)))
  if (maxPriceCents != null) params.set('maxPrice', String(Math.floor(maxPriceCents / 100)))
  params.set('radius', String(radiusKm))
  params.set('sortBy', sortBy)
  params.set('exact', 'false')

  const path = category ? `${slug}/${category}` : `${slug}/search`
  return `https://www.facebook.com/marketplace/${path}?${params}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/fb-search.test.mjs`
Expected: `# pass 8`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/source/facebook/search.mjs test/fb-search.test.mjs
git commit -m "feat: marketplace search URL construction with price and radius filters"
```

---

## Task 13: Listing Parser (Pure, Fixture-Testable)

**Files:**
- Create: `src/source/facebook/parse.mjs`
- Test: `test/fb-parse.test.mjs`

Facebook's CSS class names are obfuscated hashes that rotate. Parsing by class is guaranteed to break. Instead, the browser layer extracts a flat array of `{href, lines}` from anchors whose href matches `/marketplace/item/<id>/`, and this pure module turns those into listings. That makes the parser fully testable with no browser and resistant to styling changes.

- [ ] **Step 1: Write the failing test**

Create `test/fb-parse.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePriceCents, parseListingNode, parseListingNodes, extractFbId } from '../src/source/facebook/parse.mjs'

test('extractFbId pulls the numeric id from a marketplace href', () => {
  assert.equal(extractFbId('/marketplace/item/1234567890123/?ref=search'), '1234567890123')
  assert.equal(extractFbId('https://www.facebook.com/marketplace/item/999/'), '999')
  assert.equal(extractFbId('/marketplace/category/electronics'), null)
})

test('parsePriceCents handles plain, comma, decimal and free', () => {
  assert.equal(parsePriceCents('$250'), 25000)
  assert.equal(parsePriceCents('$1,299'), 129900)
  assert.equal(parsePriceCents('$99.50'), 9950)
  assert.equal(parsePriceCents('Free'), 0)
  assert.equal(parsePriceCents('CA$250'), 25000)
  assert.equal(parsePriceCents('no price'), null)
})

test('a strikethrough original price is ignored in favour of the current price', () => {
  const node = { href: '/marketplace/item/1/', lines: ['$180', '$300', 'MacBook Air 2019', 'Brooklyn, NY'] }
  assert.equal(parseListingNode(node).priceCents, 18000)
})

test('parseListingNode extracts price, title and city', () => {
  const node = { href: '/marketplace/item/1234/', lines: ['$250', 'Apple MacBook Air 13 inch', 'Brooklyn, NY'] }
  const l = parseListingNode(node)
  assert.equal(l.fbId, '1234')
  assert.equal(l.priceCents, 25000)
  assert.equal(l.title, 'Apple MacBook Air 13 inch')
  assert.equal(l.city, 'Brooklyn, NY')
  assert.equal(l.url, 'https://www.facebook.com/marketplace/item/1234/')
})

test('a free listing parses to zero rather than null', () => {
  const l = parseListingNode({ href: '/marketplace/item/5/', lines: ['Free', 'Old couch', 'Queens, NY'] })
  assert.equal(l.priceCents, 0)
  assert.equal(l.title, 'Old couch')
})

test('a node with no price is rejected', () => {
  assert.equal(parseListingNode({ href: '/marketplace/item/6/', lines: ['Some text', 'More text'] }), null)
})

test('a node with no item id is rejected', () => {
  assert.equal(parseListingNode({ href: '/marketplace/category/tools', lines: ['$10', 'thing'] }), null)
})

test('parseListingNodes dedupes repeated ids and drops rejects', () => {
  const nodes = [
    { href: '/marketplace/item/1/', lines: ['$10', 'A', 'NY'] },
    { href: '/marketplace/item/1/', lines: ['$10', 'A', 'NY'] },
    { href: '/marketplace/item/2/', lines: ['$20', 'B', 'NY'] },
    { href: '/marketplace/category/x', lines: ['$30', 'C'] },
  ]
  const out = parseListingNodes(nodes)
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((l) => l.fbId), ['1', '2'])
})

test('noise lines are stripped from the title candidate', () => {
  const node = { href: '/marketplace/item/7/', lines: ['$45', 'Just listed', 'Dewalt drill 20v', 'Newark, NJ'] }
  assert.equal(parseListingNode(node).title, 'Dewalt drill 20v')
})

test('seenAt is stamped from the injected clock', () => {
  const l = parseListingNode({ href: '/marketplace/item/8/', lines: ['$1', 'x', 'NY'] }, { now: 4242 })
  assert.equal(l.seenAt, 4242)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/fb-parse.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/source/facebook/parse.mjs**

```js
const ITEM_ID_RE = /\/marketplace\/item\/(\d+)/
const PRICE_RE = /^[^\d]{0,4}\$?\s?([\d,]+(?:\.\d{1,2})?)\s*$/
const FREE_RE = /^free$/i

// Chrome-injected UI text that is never a title.
const NOISE_RE = /^(just listed|new listing|sponsored|free shipping|shipping available|see more|save|share|listed \w+ ago|\d+ (miles?|km) away)$/i

export function extractFbId (href) {
  const m = String(href || '').match(ITEM_ID_RE)
  return m ? m[1] : null
}

export function parsePriceCents (text) {
  const s = String(text ?? '').trim()
  if (FREE_RE.test(s)) return 0
  const m = s.match(PRICE_RE)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * Facebook renders a listing card as an anchor containing, in order:
 * current price, optional strikethrough original price, title, location.
 * We take the FIRST price line as current, because a discounted card puts the
 * live price first and the crossed-out one second. Taking the max would value
 * every discounted listing at its pre-discount price.
 */
export function parseListingNode (node, { now = Date.now() } = {}) {
  const fbId = extractFbId(node.href)
  if (!fbId) return null

  const lines = (node.lines ?? []).map((l) => String(l).trim()).filter(Boolean)
  let priceCents = null
  let priceIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const p = parsePriceCents(lines[i])
    if (p !== null) { priceCents = p; priceIndex = i; break }
  }
  if (priceCents === null) return null

  const rest = lines
    .slice(priceIndex + 1)
    .filter((l) => parsePriceCents(l) === null && !NOISE_RE.test(l))

  const title = rest[0] ?? null
  if (!title) return null
  const city = rest.length > 1 ? rest[rest.length - 1] : null

  return {
    fbId,
    title,
    priceCents,
    city,
    url: `https://www.facebook.com/marketplace/item/${fbId}/`,
    seenAt: now,
  }
}

export function parseListingNodes (nodes, opts = {}) {
  const seen = new Set()
  const out = []
  for (const n of nodes) {
    const l = parseListingNode(n, opts)
    if (!l || seen.has(l.fbId)) continue
    seen.add(l.fbId)
    out.push(l)
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/fb-parse.test.mjs`
Expected: `# pass 10`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/source/facebook/parse.mjs test/fb-parse.test.mjs
git commit -m "feat: class-name-independent Marketplace listing parser"
```

---

## Task 14: Browser Session, Block Detection and the Source Implementation

**Files:**
- Create: `src/source/facebook/session.mjs`, `src/source/facebook/detail.mjs`, `src/source/facebook/index.mjs`
- Modify: `src/cli.mjs` (add `login` and `scan` commands)
- Test: `test/fb-session.test.mjs`, `test/fb-detail.test.mjs`

- [ ] **Step 1: Write the failing test for block detection and detail parsing**

Create `test/fb-session.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectBlock, EXTRACT_NODES_FN, isLoggedInFromText } from '../src/source/facebook/session.mjs'

test('detectBlock recognises a login wall', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/login/?next=x', bodyText: 'Log in to Facebook' })
  assert.equal(r.blocked, true)
  assert.equal(r.kind, 'login_wall')
})

test('detectBlock recognises a checkpoint', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/checkpoint/12345', bodyText: 'anything' })
  assert.equal(r.blocked, true)
  assert.equal(r.kind, 'checkpoint')
})

test('detectBlock recognises a rate-limit interstitial by body text', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/marketplace/nyc/search', bodyText: 'You’re temporarily blocked from using this feature' })
  assert.equal(r.blocked, true)
  assert.equal(r.kind, 'temporarily_blocked')
})

test('detectBlock passes a normal marketplace page', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/marketplace/nyc/search?query=x', bodyText: 'Today’s picks $250 MacBook' })
  assert.equal(r.blocked, false)
})

test('isLoggedInFromText is false when the login form is present', () => {
  assert.equal(isLoggedInFromText('Log into Facebook Email or phone Password'), false)
  assert.equal(isLoggedInFromText('Marketplace Today’s picks Sell'), true)
})

test('EXTRACT_NODES_FN is a self-contained function source string for page.evaluate', () => {
  assert.equal(typeof EXTRACT_NODES_FN, 'function')
  // It must not close over anything from this module - it runs in the page context.
  assert.ok(!/import |require\(/.test(EXTRACT_NODES_FN.toString()))
})
```

Create `test/fb-detail.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDetail, parseListedAt } from '../src/source/facebook/detail.mjs'

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0)

test('parseListedAt converts relative times to absolute timestamps', () => {
  assert.equal(parseListedAt('Listed 2 hours ago', NOW), NOW - 2 * 3600000)
  assert.equal(parseListedAt('Listed 3 days ago in Brooklyn, NY', NOW), NOW - 3 * 86400000)
  assert.equal(parseListedAt('Listed 45 minutes ago', NOW), NOW - 45 * 60000)
  assert.equal(parseListedAt('Listed a week ago', NOW), NOW - 7 * 86400000)
  assert.equal(parseListedAt('no time here', NOW), null)
})

test('parseDetail extracts description, seller, images and delivery', () => {
  const d = parseDetail({
    bodyLines: [
      '$250',
      'Apple MacBook Air 13 inch 2019',
      'Listed 2 hours ago in Brooklyn, NY',
      'Condition: Used - Good',
      'Description',
      'Barely used, comes with charger. 256gb ssd.',
      'Seller information',
      'Jane Doe',
      'Local pickup only',
    ],
    imageUrls: ['https://scontent.example/a.jpg', 'https://scontent.example/b.jpg'],
    now: NOW,
  })
  assert.match(d.description, /Barely used/)
  assert.equal(d.sellerName, 'Jane Doe')
  assert.equal(d.delivery, 'pickup')
  assert.equal(d.imageUrls.length, 2)
  assert.equal(d.listedAt, NOW - 2 * 3600000)
  assert.equal(d.condition, 'Used - Good')
})

test('shipping availability is detected', () => {
  const d = parseDetail({ bodyLines: ['$10', 'Thing', 'Shipping available'], imageUrls: [], now: NOW })
  assert.equal(d.delivery, 'shipping')
})

test('both delivery methods are detected', () => {
  const d = parseDetail({ bodyLines: ['$10', 'Thing', 'Shipping and local pickup'], imageUrls: [], now: NOW })
  assert.equal(d.delivery, 'both')
})

test('a missing description returns null instead of an empty string', () => {
  const d = parseDetail({ bodyLines: ['$10', 'Thing'], imageUrls: [], now: NOW })
  assert.equal(d.description, null)
})
```

- [ ] **Step 2: Run to verify both fail**

Run: `node --test test/fb-session.test.mjs test/fb-detail.test.mjs`
Expected: FAIL, modules not found

- [ ] **Step 3: Implement src/source/facebook/session.mjs**

```js
import path from 'node:path'
import { chromium } from 'playwright'

const CHECKPOINT_RE = /\/checkpoint\//
const LOGIN_RE = /\/login\/?/
const BLOCKED_RE = /(temporarily blocked|you're blocked|unusual activity|please try again later)/i
const LOGIN_FORM_RE = /(log in(to)? facebook|email or phone.*password)/i

export function detectBlock ({ url, bodyText }) {
  if (CHECKPOINT_RE.test(url)) return { blocked: true, kind: 'checkpoint' }
  if (LOGIN_RE.test(url)) return { blocked: true, kind: 'login_wall' }
  if (BLOCKED_RE.test(bodyText ?? '')) return { blocked: true, kind: 'temporarily_blocked' }
  return { blocked: false, kind: null }
}

export function isLoggedInFromText (bodyText) {
  return !LOGIN_FORM_RE.test(String(bodyText ?? '').toLowerCase())
}

/**
 * Runs inside the page. Must be fully self-contained: no closures, no imports.
 * Returns a flat array of {href, lines} for every marketplace item anchor,
 * which src/source/facebook/parse.mjs turns into listings. Selecting by href
 * pattern rather than class name is what makes this survive Facebook's
 * rotating obfuscated class names.
 */
export function EXTRACT_NODES_FN () {
  const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
  return anchors.map((a) => ({
    href: a.getAttribute('href') || '',
    lines: (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean),
    image: (a.querySelector('img') || {}).src || null,
  }))
}

export function EXTRACT_DETAIL_FN () {
  const main = document.querySelector('[role="main"]') || document.body
  return {
    bodyLines: (main.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean),
    imageUrls: Array.from(document.querySelectorAll('img'))
      .map((i) => i.src)
      .filter((s) => s && s.includes('scontent') && !s.startsWith('data:'))
      .slice(0, 6),
  }
}

export async function openSession ({
  profileDir = process.env.FBAY_FB_PROFILE_DIR || './fb-profile',
  headless = true,
  browserType = chromium,
} = {}) {
  const context = await browserType.launchPersistentContext(path.resolve(profileDir), {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = context.pages()[0] ?? (await context.newPage())
  return {
    context,
    page,
    async close () { await context.close() },
    async goto (url, { waitMs = 2500 } = {}) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(waitMs)
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000))
      return { url: page.url(), bodyText, block: detectBlock({ url: page.url(), bodyText }) }
    },
    async isLoggedIn () {
      await page.goto('https://www.facebook.com/marketplace/', { waitUntil: 'domcontentloaded', timeout: 45000 })
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000))
      return isLoggedInFromText(bodyText) && !detectBlock({ url: page.url(), bodyText }).blocked
    },
    async extractNodes () { return page.evaluate(EXTRACT_NODES_FN) },
    async extractDetail () { return page.evaluate(EXTRACT_DETAIL_FN) },
    async scroll (times = 3, pauseMs = 1200) {
      for (let i = 0; i < times; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9))
        await page.waitForTimeout(pauseMs)
      }
    },
  }
}
```

- [ ] **Step 4: Implement src/source/facebook/detail.mjs**

```js
const REL_TIME_RE = /listed\s+(a|an|\d+)\s*(minute|hour|day|week|month)s?\s+ago/i
const UNIT_MS = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 }

const SELLER_MARKER_RE = /^(seller information|about the seller|listed by)$/i
const DESC_MARKER_RE = /^(description|details)$/i
const CONDITION_RE = /^condition:\s*(.+)$/i

export function parseListedAt (text, now = Date.now()) {
  const m = String(text ?? '').match(REL_TIME_RE)
  if (!m) return null
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1
  return now - n * UNIT_MS[m[2].toLowerCase()]
}

function detectDelivery (lines) {
  const joined = lines.join(' ').toLowerCase()
  const pickup = /local pickup|pickup only|meet up/.test(joined)
  const shipping = /shipping available|shipping and local pickup|ships from/.test(joined)
  if (pickup && shipping) return 'both'
  if (/shipping and local pickup/.test(joined)) return 'both'
  if (shipping) return 'shipping'
  if (pickup) return 'pickup'
  return null
}

export function parseDetail ({ bodyLines = [], imageUrls = [], now = Date.now() }) {
  const listedLine = bodyLines.find((l) => REL_TIME_RE.test(l))
  const conditionLine = bodyLines.find((l) => CONDITION_RE.test(l))

  let description = null
  const descIdx = bodyLines.findIndex((l) => DESC_MARKER_RE.test(l))
  if (descIdx !== -1) {
    const tail = []
    for (let i = descIdx + 1; i < bodyLines.length; i++) {
      if (SELLER_MARKER_RE.test(bodyLines[i])) break
      tail.push(bodyLines[i])
    }
    if (tail.length) description = tail.join('\n')
  }

  let sellerName = null
  const sellerIdx = bodyLines.findIndex((l) => SELLER_MARKER_RE.test(l))
  if (sellerIdx !== -1 && bodyLines[sellerIdx + 1]) sellerName = bodyLines[sellerIdx + 1]

  return {
    description,
    sellerName,
    condition: conditionLine ? conditionLine.match(CONDITION_RE)[1].trim() : null,
    listedAt: listedLine ? parseListedAt(listedLine, now) : null,
    delivery: detectDelivery(bodyLines),
    imageUrls,
  }
}
```

- [ ] **Step 5: Implement src/source/facebook/index.mjs**

```js
import { buildSearchUrl } from './search.mjs'
import { parseListingNodes } from './parse.mjs'
import { parseDetail } from './detail.mjs'
import { PaceLimitError } from './pace.mjs'

/**
 * The Source interface: scan(watch) -> {ok, listings, warnings, blocked}.
 * A second source (Apify, another marketplace) only has to satisfy this shape.
 */
export function createFacebookSource ({ session, pacer, clock = Date.now, scrolls = 3 }) {
  async function scan (watch, { fetchDetails = true } = {}) {
    const warnings = []
    const url = buildSearchUrl({
      city: watch.city,
      query: watch.query,
      category: watch.category,
      minPriceCents: watch.min_price_cents ?? watch.minPriceCents,
      maxPriceCents: watch.max_price_cents ?? watch.maxPriceCents,
      radiusKm: watch.radius_km ?? watch.radiusKm,
      sort: watch.sort,
    })

    try {
      await pacer.beforeRequest()
    } catch (e) {
      if (e instanceof PaceLimitError) return { ok: false, error: e.message, kind: e.kind, listings: [], warnings }
      throw e
    }

    const nav = await session.goto(url)
    if (nav.block.blocked) {
      const info = pacer.recordBlock(nav.block.kind)
      return { ok: false, blocked: true, kind: nav.block.kind, error: `facebook blocked us: ${nav.block.kind}`, cooldownUntil: info.cooldownUntil, listings: [], warnings }
    }

    await session.scroll(scrolls)
    const nodes = await session.extractNodes()
    const listings = parseListingNodes(nodes, { now: clock() })
    pacer.countListings(listings.length)

    if (!fetchDetails) return { ok: true, listings, warnings, url }

    const detailed = []
    for (const l of listings) {
      if (pacer.listingBudgetExhausted()) { warnings.push('daily listing budget exhausted'); break }
      if (!pacer.shouldFetchDetail()) { detailed.push(l); continue }
      try {
        await pacer.beforeRequest()
      } catch (e) {
        if (e instanceof PaceLimitError) { warnings.push(e.message); detailed.push(l); break }
        throw e
      }
      const dnav = await session.goto(l.url, { waitMs: 2000 })
      if (dnav.block.blocked) {
        pacer.recordBlock(dnav.block.kind)
        warnings.push(`blocked on detail fetch: ${dnav.block.kind}`)
        detailed.push(l)
        break
      }
      const raw = await session.extractDetail()
      detailed.push({ ...l, ...parseDetail({ ...raw, now: clock() }) })
    }

    return { ok: true, listings: detailed, warnings, url }
  }

  return { name: 'facebook', scan }
}
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/fb-session.test.mjs test/fb-detail.test.mjs`
Expected: `# pass 11`, `# fail 0`

- [ ] **Step 7: Add `login` and `scan` commands to src/cli.mjs**

Add these imports at the top of `src/cli.mjs`:

```js
import { openSession } from './source/facebook/session.mjs'
import { createFacebookSource } from './source/facebook/index.mjs'
import { createPacer } from './source/facebook/pace.mjs'
```

Add these entries inside the `COMMANDS` object:

```js
  async login () {
    console.log('Opening a browser. Log into Facebook, then close the window when Marketplace loads.')
    const session = await openSession({ headless: false })
    await session.page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' })
    await session.page.waitForURL((u) => !/\/login/.test(String(u)), { timeout: 300000 }).catch(() => {})
    const ok = await session.isLoggedIn()
    console.log(ok ? 'Session saved. You are logged in.' : 'Still not logged in. Run `fbay login` again.')
    await session.close()
  },

  async scan (args) {
    const dry = args.includes('--dry')
    const nameIdx = args.indexOf('--watch')
    const watchName = nameIdx !== -1 ? args[nameIdx + 1] : null

    const { config, repo } = buildContext()
    const watches = repo.listWatches({ enabledOnly: true }).filter((w) => !watchName || w.name === watchName)
    if (!watches.length) {
      console.error('no enabled watches. add one with: fbay watch add --name X --city nyc --query "macbook"')
      process.exitCode = 1
      return
    }

    const session = await openSession({ headless: !process.env.FBAY_HEADED })
    const pacer = createPacer({ config: config.pace })
    const source = createFacebookSource({ session, pacer })

    for (const w of watches) {
      const r = await source.scan(w, { fetchDetails: !dry })
      if (!r.ok) { console.error(`[${w.name}] ${r.error}`); continue }
      console.log(`\n[${w.name}] ${r.listings.length} listings`)
      for (const l of r.listings) console.log(`  ${money(l.priceCents).padStart(10)}  ${l.title.slice(0, 60)}`)
      for (const warn of r.warnings) console.warn(`  warning: ${warn}`)
      if (!dry) {
        for (const l of r.listings) repo.upsertListing({ ...l, watchId: w.id })
      }
    }
    await session.close()
  },

  async watch (args) {
    const { repo } = buildContext()
    const [sub, ...rest] = args
    const flag = (name) => { const i = rest.indexOf(`--${name}`); return i === -1 ? undefined : rest[i + 1] }

    if (sub === 'add') {
      const name = flag('name')
      const city = flag('city')
      if (!name || !city) { console.error('usage: fbay watch add --name X --city nyc [--query "..."] [--category electronics] [--max 500] [--radius 40]'); process.exitCode = 1; return }
      repo.addWatch({
        name, city, query: flag('query') ?? '', category: flag('category'),
        radiusKm: flag('radius') ? Number(flag('radius')) : 40,
        minPriceCents: flag('min') ? Number(flag('min')) * 100 : null,
        maxPriceCents: flag('max') ? Number(flag('max')) * 100 : null,
        intervalMinutes: flag('interval') ? Number(flag('interval')) : 60,
      })
      console.log(`added watch "${name}"`)
      return
    }
    if (sub === 'enable' || sub === 'disable') {
      repo.setWatchEnabled(rest[0], sub === 'enable')
      console.log(`${sub}d ${rest[0]}`)
      return
    }
    console.table(repo.listWatches().map((w) => ({ name: w.name, city: w.city, query: w.query, max: w.max_price_cents ? money(w.max_price_cents) : '', enabled: !!w.enabled })))
  },
```

- [ ] **Step 8: Verify the browser path against live Facebook**

Run:

```bash
./fbay login
./fbay watch add --name macbooks --city nyc --query "macbook pro" --max 900
./fbay scan --watch macbooks --dry
```

Expected: `fbay login` opens a visible browser; after logging in it prints `Session saved.` Then `scan --dry` prints at least 10 rows of real prices and titles. If it prints `facebook blocked us: login_wall`, run `fbay login` again.

- [ ] **Step 9: Commit**

```bash
git add src/source test/fb-session.test.mjs test/fb-detail.test.mjs src/cli.mjs
git commit -m "feat: facebook session, block detection, detail parsing and scan command"
```

**Phase 3 complete.** Real listings flow into the database.

---
## Task 15: Claude Client with Forced Structured Output

**Files:**
- Create: `src/llm.mjs`
- Test: `test/llm.test.mjs`

Structured extraction uses a forced tool call rather than "return JSON" prompting, so the model cannot return prose around the object and a schema mismatch is a retryable error rather than a parse crash.

- [ ] **Step 1: Write the failing test**

Create `test/llm.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLlmClient, MODELS } from '../src/llm.mjs'

function fakeAnthropic (responses) {
  const calls = []
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req)
        const r = responses.shift()
        if (r instanceof Error) throw r
        return r
      },
    },
  }
}

const toolResponse = (input) => ({
  content: [{ type: 'tool_use', name: 'emit', input }],
  usage: { input_tokens: 10, output_tokens: 5 },
  model: MODELS.fast,
})

const SCHEMA = { type: 'object', properties: { brand: { type: 'string' } }, required: ['brand'] }

test('extractStructured returns the tool input', async () => {
  const client = createLlmClient({ anthropic: fakeAnthropic([toolResponse({ brand: 'Apple' })]) })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, true)
  assert.equal(r.data.brand, 'Apple')
})

test('the request forces the tool so the model cannot answer in prose', async () => {
  const api = fakeAnthropic([toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api })
  await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.deepEqual(api.calls[0].tool_choice, { type: 'tool', name: 'emit' })
  assert.deepEqual(api.calls[0].tools[0].input_schema, SCHEMA)
})

test('images are attached as base64 content blocks', async () => {
  const api = fakeAnthropic([toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api })
  await client.extractStructured({
    system: 's', user: 'u', schema: SCHEMA,
    images: [{ mediaType: 'image/jpeg', base64: 'AAAA' }],
  })
  const content = api.calls[0].messages[0].content
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].source.media_type, 'image/jpeg')
  assert.equal(content[content.length - 1].type, 'text')
})

test('a response with no tool_use block is an error, not a crash', async () => {
  const client = createLlmClient({ anthropic: fakeAnthropic([{ content: [{ type: 'text', text: 'sorry' }] }]), retries: 0 })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, false)
  assert.match(r.error, /no structured output/i)
})

test('a transient API error is retried', async () => {
  const api = fakeAnthropic([new Error('overloaded'), toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api, retries: 2, sleepImpl: async () => {} })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, true)
  assert.equal(api.calls.length, 2)
})

test('retries are bounded and the last error is reported', async () => {
  const api = fakeAnthropic([new Error('boom'), new Error('boom'), new Error('boom')])
  const client = createLlmClient({ anthropic: api, retries: 2, sleepImpl: async () => {} })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
  assert.equal(api.calls.length, 3)
})

test('the model can be overridden per call for escalation', async () => {
  const api = fakeAnthropic([toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api })
  await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA, model: MODELS.smart })
  assert.equal(api.calls[0].model, MODELS.smart)
})

test('token usage is reported back for cost tracking', async () => {
  const client = createLlmClient({ anthropic: fakeAnthropic([toolResponse({ brand: 'Apple' })]) })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.usage.input_tokens, 10)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/llm.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/llm.mjs**

```js
import Anthropic from '@anthropic-ai/sdk'

export const MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  smart: 'claude-opus-5',
}

export function createLlmClient ({
  apiKey = process.env.ANTHROPIC_API_KEY,
  anthropic = null,
  defaultModel = MODELS.fast,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const api = anthropic ?? new Anthropic({ apiKey })

  async function extractStructured ({ system, user, schema, images = [], model = defaultModel, maxTokens = 1024 }) {
    const content = [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      })),
      { type: 'text', text: user },
    ]

    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await api.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }],
          tools: [{
            name: 'emit',
            description: 'Emit the extracted structured result. This is the only valid way to answer.',
            input_schema: schema,
          }],
          tool_choice: { type: 'tool', name: 'emit' },
        })
        const block = (res.content ?? []).find((c) => c.type === 'tool_use')
        if (!block) {
          lastError = 'model returned no structured output'
        } else {
          return { ok: true, data: block.input, usage: res.usage ?? {}, model: res.model ?? model }
        }
      } catch (e) {
        lastError = e.message ?? String(e)
      }
      if (attempt < retries) await sleepImpl(500 * 2 ** attempt)
    }
    return { ok: false, error: lastError }
  }

  async function completeText ({ system, user, model = defaultModel, maxTokens = 512 }) {
    try {
      const res = await api.messages.create({
        model, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      })
      const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim()
      return { ok: true, text, usage: res.usage ?? {} }
    } catch (e) {
      return { ok: false, error: e.message ?? String(e) }
    }
  }

  return { extractStructured, completeText }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/llm.test.mjs`
Expected: `# pass 8`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/llm.mjs test/llm.test.mjs
git commit -m "feat: claude client with forced structured output and bounded retries"
```

---

## Task 16: Identity Extraction

**Files:**
- Create: `src/identify/cache.mjs`, `src/identify/extract.mjs`
- Test: `test/identify.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/identify.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'
import { contentHash, identityKeyFor } from '../src/identify/cache.mjs'
import { identify, IDENTITY_SCHEMA, buildUserPrompt, normaliseIdentity, CATEGORIES, CONDITIONS } from '../src/identify/extract.mjs'
import { DEFAULTS } from '../src/config.mjs'

const listing = { fbId: '1', title: 'MacBook good condition', description: '13 inch 2019 256gb', priceCents: 40000, imageUrls: ['https://x/a.jpg'] }

const RAW = {
  brand: 'Apple', model: 'MacBook Air', variant: '13-inch', capacity: '256GB',
  modelYear: 2019, category: 'laptop', condition: 'good', identityConfidence: 0.82,
  query: 'apple macbook air 13 2019 256gb', mustTokens: ['macbook', 'air', '2019'], weightLb: 5,
}

function fakeLlm (data, { onCall } = {}) {
  return {
    extractStructured: async (req) => {
      onCall?.(req)
      return { ok: true, data, usage: {}, model: 'test-model' }
    },
  }
}

test('contentHash is stable and changes with content', () => {
  assert.equal(contentHash(listing), contentHash({ ...listing }))
  assert.notEqual(contentHash(listing), contentHash({ ...listing, title: 'other' }))
})

test('identityKeyFor ignores irrelevant fields and normalises case', () => {
  const a = identityKeyFor({ brand: 'Apple', model: 'MacBook Air', variant: '13-inch', capacity: '256GB', category: 'laptop', condition: 'good' })
  const b = identityKeyFor({ brand: 'apple', model: 'macbook air', variant: '13-INCH', capacity: '256gb', category: 'laptop', condition: 'good', modelYear: 2019 })
  assert.equal(a, b)
})

test('identityKeyFor separates different conditions', () => {
  const good = identityKeyFor({ brand: 'a', model: 'b', category: 'laptop', condition: 'good' })
  const parts = identityKeyFor({ brand: 'a', model: 'b', category: 'laptop', condition: 'for_parts' })
  assert.notEqual(good, parts)
})

test('IDENTITY_SCHEMA constrains category and condition to known enums', () => {
  assert.deepEqual(IDENTITY_SCHEMA.properties.category.enum, CATEGORIES)
  assert.deepEqual(IDENTITY_SCHEMA.properties.condition.enum, CONDITIONS)
})

test('buildUserPrompt includes the title, description and ask price', () => {
  const p = buildUserPrompt(listing)
  assert.match(p, /MacBook good condition/)
  assert.match(p, /13 inch 2019 256gb/)
  assert.match(p, /\$400/)
})

test('normaliseIdentity lowercases must tokens and clamps confidence', () => {
  const n = normaliseIdentity({ ...RAW, mustTokens: ['MacBook', 'AIR'], identityConfidence: 1.7 })
  assert.deepEqual(n.mustTokens, ['macbook', 'air'])
  assert.equal(n.identityConfidence, 1)
})

test('normaliseIdentity falls back to a safe category and condition', () => {
  const n = normaliseIdentity({ ...RAW, category: 'not_a_category', condition: 'weird' })
  assert.equal(n.category, 'other')
  assert.equal(n.condition, 'good')
})

test('identify calls the model and persists the result', async () => {
  const repo = createRepo(openDb(':memory:'))
  const r = await identify({ listing, repo, llm: fakeLlm(RAW), config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(r.ok, true)
  assert.equal(r.cached, false)
  assert.equal(r.identity.brand, 'Apple')
  assert.ok(r.identity.identityKey)
  assert.ok(repo.getIdentityByContentHash(contentHash(listing)))
})

test('a second identify for the same content is served from cache with no model call', async () => {
  const repo = createRepo(openDb(':memory:'))
  let calls = 0
  const llm = { extractStructured: async () => { calls++; return { ok: true, data: RAW, usage: {}, model: 'm' } } }
  await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  const second = await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(calls, 1)
  assert.equal(second.cached, true)
  assert.equal(second.identity.model, 'MacBook Air')
})

test('low confidence escalates to the smart model exactly once', async () => {
  const repo = createRepo(openDb(':memory:'))
  const models = []
  const llm = {
    extractStructured: async (req) => {
      models.push(req.model)
      return { ok: true, data: { ...RAW, identityConfidence: models.length === 1 ? 0.3 : 0.88 }, usage: {}, model: req.model }
    },
  }
  const r = await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(models.length, 2)
  assert.notEqual(models[0], models[1])
  assert.equal(r.identity.identityConfidence, 0.88)
  assert.equal(r.escalated, true)
})

test('images are fetched and passed to the model when available', async () => {
  const repo = createRepo(openDb(':memory:'))
  let seenImages = null
  const llm = fakeLlm(RAW, { onCall: (req) => { seenImages = req.images } })
  await identify({
    listing, repo, llm, config: DEFAULTS,
    imageFetcher: async () => ({ mediaType: 'image/jpeg', base64: 'AAA' }),
  })
  assert.equal(seenImages.length, 1)
  assert.equal(seenImages[0].mediaType, 'image/jpeg')
})

test('a model failure returns ok:false and persists nothing', async () => {
  const repo = createRepo(openDb(':memory:'))
  const llm = { extractStructured: async () => ({ ok: false, error: 'overloaded' }) }
  const r = await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(r.ok, false)
  assert.match(r.error, /overloaded/)
  assert.equal(repo.getIdentityByContentHash(contentHash(listing)), undefined)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/identify.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/identify/cache.mjs**

```js
import { createHash } from 'node:crypto'

function sha (s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

/** Keyed on what the model would actually see. Changing the ask price must not bust it. */
export function contentHash (listing) {
  return sha([listing.title ?? '', listing.description ?? '', (listing.imageUrls ?? [])[0] ?? ''].join(' '))
}

/**
 * Keyed on the item itself, so two listings of the same phone share one CompSet.
 * Condition is part of the key because a for-parts unit is a different product.
 * modelYear is deliberately excluded: sellers get it wrong constantly and it
 * would fragment the cache without improving the comps.
 */
export function identityKeyFor (i) {
  const parts = [i.brand, i.model, i.variant, i.capacity, i.category, i.condition]
    .map((p) => String(p ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
  return sha(parts.join('|'))
}
```

- [ ] **Step 4: Implement src/identify/extract.mjs**

```js
import { MODELS } from '../llm.mjs'
import { contentHash, identityKeyFor } from './cache.mjs'

export const CATEGORIES = [
  'phone', 'tablet', 'laptop', 'camera', 'audio', 'gaming_console', 'gaming_accessory',
  'tv', 'tools', 'appliance', 'furniture', 'bicycle', 'exercise_equipment', 'clothing',
  'athletic_shoes', 'jewelry', 'watches', 'books_movies_music', 'musical_instrument',
  'trading_cards', 'heavy_equipment', 'toys', 'baby', 'sporting_goods', 'other',
]

export const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'for_parts']

export const IDENTITY_SCHEMA = {
  type: 'object',
  properties: {
    brand: { type: 'string', description: 'Manufacturer. Empty string if genuinely unknown.' },
    model: { type: 'string', description: 'Model name or number as a reseller would search for it.' },
    variant: { type: 'string', description: 'Size, trim or sub-model. Empty string if none.' },
    capacity: { type: 'string', description: 'Storage or capacity, e.g. 256GB. Empty string if not applicable.' },
    modelYear: { type: 'integer', description: 'Model year if determinable, otherwise 0.' },
    category: { type: 'string', enum: CATEGORIES },
    condition: { type: 'string', enum: CONDITIONS },
    identityConfidence: { type: 'number', description: '0 to 1. How certain you are this is the exact item.' },
    query: { type: 'string', description: 'The eBay search string a reseller would type to find sold comps.' },
    mustTokens: {
      type: 'array', items: { type: 'string' },
      description: 'Lowercase tokens a comparable sold listing MUST contain. Include the model number and any capacity that changes value. Do not include generic words.',
    },
    weightLb: { type: 'number', description: 'Estimated shipping weight in pounds including packaging. 0 if unknown.' },
  },
  required: ['brand', 'model', 'category', 'condition', 'identityConfidence', 'query', 'mustTokens'],
}

export const SYSTEM_PROMPT = `You identify second-hand items for resale arbitrage.

You are given a Facebook Marketplace listing: a sloppy title, an optional description, and photos. Your job is to work out exactly what the item is, precisely enough that a search of eBay sold listings returns comparable units and nothing else.

Rules:
- Photos outrank text. Sellers write "MacBook" for a 2015 Pro and a 2023 Air alike. Read the photos for the actual model, port layout, screen size, and physical damage.
- Condition drives value more than anything else. A cracked screen, missing parts, or heavy wear means fair or for_parts, not good. If the photos show damage the text does not mention, trust the photos.
- mustTokens is a filter, not a description. Include only tokens that a wrong-model listing would fail: the model number, the capacity when it changes price, the generation. Never include generic words like "used", "great", "working", or the brand alone.
- query is what a reseller types into eBay. Brand, model, key spec. No adjectives, no condition words.
- identityConfidence is honest. If the photos are dark, the item is partly out of frame, or the model could be one of several, say so with a low number. A confident wrong answer costs real money.
- If you truly cannot tell what it is, set category "other" and identityConfidence below 0.3.`

export function buildUserPrompt (listing) {
  const price = `$${((listing.priceCents ?? 0) / 100).toFixed(0)}`
  return [
    `Title: ${listing.title ?? '(none)'}`,
    `Description: ${listing.description ?? '(none)'}`,
    `Seller is asking: ${price}`,
    listing.condition ? `Seller-stated condition: ${listing.condition}` : null,
    '',
    'Identify this item.',
  ].filter(Boolean).join('\n')
}

export function normaliseIdentity (raw) {
  const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0))
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'other'
  const condition = CONDITIONS.includes(raw.condition) ? raw.condition : 'good'
  const identity = {
    brand: raw.brand || null,
    model: raw.model || null,
    variant: raw.variant || null,
    capacity: raw.capacity || null,
    modelYear: raw.modelYear && raw.modelYear > 1900 ? raw.modelYear : null,
    category,
    condition,
    identityConfidence: clamp(raw.identityConfidence),
    query: String(raw.query || '').trim(),
    mustTokens: (raw.mustTokens ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean),
    weightLb: raw.weightLb && raw.weightLb > 0 ? raw.weightLb : null,
  }
  identity.identityKey = identityKeyFor(identity)
  return identity
}

function rowToIdentity (row) {
  return {
    identityKey: row.identity_key,
    brand: row.brand, model: row.model, variant: row.variant, capacity: row.capacity,
    modelYear: row.model_year, category: row.category, condition: row.condition,
    identityConfidence: row.identity_confidence, query: row.query,
    mustTokens: JSON.parse(row.must_tokens), weightLb: row.weight_lb,
  }
}

/** Default image fetcher. Returns null on any failure: a missing photo degrades quality, it does not stop the pipeline. */
export async function defaultImageFetcher (url, { fetchImpl = globalThis.fetch, maxBytes = 4_000_000 } = {}) {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) return null
    const mediaType = res.headers?.get?.('content-type')?.split(';')[0] ?? 'image/jpeg'
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) return null
    return { mediaType, base64: buf.toString('base64') }
  } catch {
    return null
  }
}

export async function identify ({
  listing, repo, llm, config,
  imageFetcher = defaultImageFetcher,
  maxImages = 3,
  now = Date.now(),
}) {
  const hash = contentHash(listing)
  const cached = repo.getIdentityByContentHash(hash)
  if (cached) return { ok: true, cached: true, escalated: false, identity: rowToIdentity(cached) }

  const images = []
  for (const url of (listing.imageUrls ?? []).slice(0, maxImages)) {
    const img = await imageFetcher(url)
    if (img) images.push(img)
  }

  const request = {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(listing),
    schema: IDENTITY_SCHEMA,
    images,
    model: MODELS.fast,
  }

  let res = await llm.extractStructured(request)
  if (!res.ok) return { ok: false, error: res.error }

  let identity = normaliseIdentity(res.data)
  let escalated = false

  // One escalation only. A second uncertain answer means the photos are the problem,
  // and burning Opus tokens on it will not change that.
  if (identity.identityConfidence < config.thresholds.minIdentityConfidence) {
    const smart = await llm.extractStructured({ ...request, model: MODELS.smart })
    if (smart.ok) {
      escalated = true
      res = smart
      identity = normaliseIdentity(smart.data)
    }
  }

  repo.saveIdentity({ ...identity, contentHash: hash, modelUsed: res.model, createdAt: now })
  return { ok: true, cached: false, escalated, identity, usage: res.usage }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/identify.test.mjs`
Expected: `# pass 12`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add src/identify test/identify.test.mjs
git commit -m "feat: vision-based identity extraction with dual-key caching and one-shot escalation"
```

---

## Task 17: Pipeline Orchestrator and the `fbay price` Command

**Files:**
- Create: `src/watch/runner.mjs`
- Modify: `src/cli.mjs`
- Test: `test/runner.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/runner.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'
import { evaluateListing, runWatch } from '../src/watch/runner.mjs'
import { DEFAULTS } from '../src/config.mjs'

const DAY = 86400000
const NOW = 100 * DAY

const LISTING = { fbId: 'a1', title: 'MacBook Air', description: '13 inch 2019', priceCents: 12000, imageUrls: [], url: 'https://fb/a1', seenAt: NOW, listedAt: NOW - 3600000 }

const IDENTITY = {
  identityKey: 'k1', brand: 'Apple', model: 'MacBook Air', variant: '13', capacity: '256GB',
  category: 'phone', condition: 'good', identityConfidence: 0.9,
  query: 'apple macbook air 13 256gb', mustTokens: ['macbook'], weightLb: null,
}

const SOLD = Array.from({ length: 10 }, (_, i) => ({ title: 'Apple MacBook Air 13', priceCents: 29500 + i * 100, soldAt: NOW - (i + 1) * 3 * DAY }))

function deps ({ soldComps = SOLD, activeCount = 12, identity = IDENTITY, identifyOk = true } = {}) {
  const repo = createRepo(openDb(':memory:'))
  return {
    repo,
    config: DEFAULTS,
    identifier: async () => (identifyOk ? { ok: true, cached: false, identity } : { ok: false, error: 'model down' }),
    sold: { fetchSold: async () => ({ ok: true, strategy: 's-card', comps: soldComps }) },
    browse: { searchActive: async () => ({ ok: true, total: activeCount, items: [] }) },
    now: NOW,
  }
}

test('evaluateListing produces a passing deal with a breakeven price', async () => {
  const d = deps()
  const r = await evaluateListing({ listing: LISTING, ...d })
  assert.equal(r.ok, true)
  assert.equal(r.passed, true)
  assert.ok(r.profit.breakevenBuyCents > LISTING.priceCents)
  assert.ok(r.profit.netCents > 0)
  assert.ok(r.score > 0)
  assert.deepEqual(r.rejections, [])
})

test('a listing priced above breakeven is rejected with a reason', async () => {
  const d = deps()
  const r = await evaluateListing({ listing: { ...LISTING, priceCents: 29000 }, ...d })
  assert.equal(r.passed, false)
  assert.ok(r.rejections.some((x) => x.rule === 'min_net_profit'))
})

test('poor sell-through is rejected even when the margin looks good', async () => {
  const d = deps({ activeCount: 5000 })
  const r = await evaluateListing({ listing: LISTING, ...d })
  assert.equal(r.passed, false)
  assert.ok(r.rejections.some((x) => x.rule === 'min_sell_through'))
})

test('an identification failure yields needs_review, not a dropped listing', async () => {
  const d = deps({ identifyOk: false })
  const r = await evaluateListing({ listing: LISTING, ...d })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'needs_review')
  assert.match(r.error, /model down/)
})

test('a comps failure yields needs_review', async () => {
  const d = deps()
  d.sold = { fetchSold: async () => ({ ok: false, error: 'ebay 429' }) }
  const r = await evaluateListing({ listing: LISTING, ...d })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'needs_review')
  assert.match(r.error, /429/)
})

test('runWatch persists listings, deals and a run record', async () => {
  const d = deps()
  const source = { scan: async () => ({ ok: true, listings: [LISTING], warnings: [] }) }
  const notified = []
  const watch = { id: null, name: 'test', city: 'nyc', query: 'macbook' }
  const r = await runWatch({ watch, source, notifier: { notifyDeal: async (x) => notified.push(x) }, ...d })

  assert.equal(r.ok, true)
  assert.equal(r.listingsSeen, 1)
  assert.equal(r.listingsNew, 1)
  assert.equal(r.dealsFound, 1)
  assert.equal(notified.length, 1)
  assert.equal(d.repo.countListings(), 1)
  assert.equal(d.repo.listDeals()[0].status, 'alerted')
})

test('a listing seen twice is not re-alerted', async () => {
  const d = deps()
  const source = { scan: async () => ({ ok: true, listings: [LISTING], warnings: [] }) }
  const notified = []
  const notifier = { notifyDeal: async (x) => notified.push(x) }
  const watch = { id: null, name: 'test', city: 'nyc', query: 'macbook' }
  await runWatch({ watch, source, notifier, ...d })
  await runWatch({ watch, source, notifier, ...d })
  assert.equal(notified.length, 1)
})

test('a price drop on a seen listing re-alerts', async () => {
  const d = deps()
  const notified = []
  const notifier = { notifyDeal: async (x) => notified.push(x) }
  const watch = { id: null, name: 'test', city: 'nyc', query: 'macbook' }
  let price = 12000
  const source = { scan: async () => ({ ok: true, listings: [{ ...LISTING, priceCents: price }], warnings: [] }) }
  await runWatch({ watch, source, notifier, ...d })
  price = 9000
  await runWatch({ watch, source, notifier, ...d })
  assert.equal(notified.length, 2)
})

test('a source failure returns ok:false and records a failed run', async () => {
  const d = deps()
  const source = { scan: async () => ({ ok: false, error: 'blocked', listings: [] }) }
  const r = await runWatch({ watch: { id: null, name: 'test' }, source, notifier: { notifyDeal: async () => {} }, ...d })
  assert.equal(r.ok, false)
  assert.match(r.error, /blocked/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runner.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/watch/runner.mjs**

```js
import { getCompSet } from '../comps/index.mjs'
import { computeProfit } from '../economics/profit.mjs'
import { applyFilters } from '../score/filters.mjs'
import { scoreDeal } from '../score/rank.mjs'

/**
 * Runs one listing through identify -> comps -> economics -> filters -> score.
 * Any stage failure returns {ok:false, status:'needs_review'} with the reason,
 * so the listing is recorded rather than silently lost.
 */
export async function evaluateListing ({ listing, repo, config, identifier, sold, browse, now = Date.now(), priceDrop = null }) {
  const idRes = await identifier({ listing, repo, config })
  if (!idRes.ok) return { ok: false, status: 'needs_review', error: `identify failed: ${idRes.error}` }
  const identity = idRes.identity

  const compRes = await getCompSet({ identity, repo, sold, browse, config, now })
  if (!compRes.ok) return { ok: false, status: 'needs_review', error: `comps failed: ${compRes.error}`, identity }
  const compset = compRes.compset

  if (compset.trimmedMedianCents == null) {
    return { ok: false, status: 'needs_review', error: 'no usable sold comps', identity, compset, compsetId: compRes.compsetId }
  }

  const profit = computeProfit({
    grossCents: compset.trimmedMedianCents,
    askCents: listing.priceCents,
    category: identity.category,
    config,
    weightLb: identity.weightLb,
    localResale: listing.delivery === 'pickup' && config.freight.enabled,
  })

  const { passed, rejections } = applyFilters({ listing, identity, compset, profit }, config)
  const score = scoreDeal({ listing, identity, compset, profit, priceDrop }, config, now)

  return {
    ok: true,
    passed,
    rejections,
    score,
    identity,
    compset,
    compsetId: compRes.compsetId,
    profit,
    confidence: identity.identityConfidence * compset.confidence,
    warnings: compRes.warnings,
  }
}

export async function runWatch ({ watch, source, repo, config, identifier, sold, browse, notifier, now = Date.now(), fetchDetails = true }) {
  const runId = repo.startRun(watch.id ?? null, now)
  const errors = []
  let listingsSeen = 0
  let listingsNew = 0
  let dealsFound = 0

  const scan = await source.scan(watch, { fetchDetails })
  if (!scan.ok) {
    repo.finishRun(runId, { now, listingsSeen: 0, listingsNew: 0, dealsFound: 0, errors: [scan.error], status: 'failed' })
    return { ok: false, error: scan.error, kind: scan.kind, runId }
  }

  for (const w of scan.warnings ?? []) errors.push(w)

  for (const listing of scan.listings) {
    listingsSeen++
    const up = repo.upsertListing({ ...listing, watchId: watch.id ?? null })
    if (up.isNew) listingsNew++
    if (listing.description || listing.sellerName) repo.updateListingDetail(listing.fbId, listing)

    // Re-evaluate only new listings or ones whose price moved. Everything else
    // is unchanged since the last pass and re-running it wastes model and eBay calls.
    if (!up.isNew && !up.priceChanged) continue

    const priceDrop = up.priceChanged && up.previousPriceCents > listing.priceCents
      ? { previousPriceCents: up.previousPriceCents, currentPriceCents: listing.priceCents }
      : null

    const ev = await evaluateListing({ listing, repo, config, identifier, sold, browse, now, priceDrop })

    if (!ev.ok) {
      errors.push(`${listing.fbId}: ${ev.error}`)
      repo.upsertDeal({ listingId: up.id, status: 'needs_review', error: ev.error, identityKey: ev.identity?.identityKey, now })
      continue
    }

    const status = ev.passed ? 'alerted' : 'passed'
    repo.upsertDeal({
      listingId: up.id,
      identityKey: ev.identity.identityKey,
      compsetId: ev.compsetId,
      grossCents: ev.compset.trimmedMedianCents,
      netProfitCents: ev.profit.netCents,
      roi: ev.profit.roi,
      margin: ev.profit.margin,
      breakevenBuyCents: ev.profit.breakevenBuyCents,
      score: ev.score,
      confidence: ev.confidence,
      status,
      rejections: ev.rejections,
      now,
    })

    if (ev.passed) {
      dealsFound++
      await notifier.notifyDeal({ listing, identity: ev.identity, compset: ev.compset, profit: ev.profit, score: ev.score, priceDrop })
    }
  }

  if (watch.id) repo.touchWatch(watch.id, now)
  repo.finishRun(runId, { now, listingsSeen, listingsNew, dealsFound, errors, status: 'ok' })
  return { ok: true, runId, listingsSeen, listingsNew, dealsFound, errors }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/runner.test.mjs`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 5: Add the `price` command to src/cli.mjs**

Add these imports:

```js
import { createLlmClient } from './llm.mjs'
import { identify } from './identify/extract.mjs'
import { evaluateListing } from './watch/runner.mjs'
import { extractFbId } from './source/facebook/parse.mjs'
import { parseDetail } from './source/facebook/detail.mjs'
```

Add this command:

```js
  async price (args) {
    const url = args[0]
    if (!extractFbId(url ?? '')) {
      console.error('usage: fbay price <facebook marketplace item url>')
      process.exitCode = 1
      return
    }
    const { config, repo, browse, sold } = buildContext()
    const llm = createLlmClient()

    const session = await openSession({ headless: !process.env.FBAY_HEADED })
    const nav = await session.goto(url, { waitMs: 3000 })
    if (nav.block.blocked) {
      console.error(`facebook blocked us: ${nav.block.kind}. run: fbay login`)
      await session.close()
      process.exitCode = 1
      return
    }
    const raw = await session.extractDetail()
    await session.close()

    const detail = parseDetail({ ...raw, now: Date.now() })
    const priceLine = raw.bodyLines.find((l) => /^\s*[^\d]{0,4}\$?\s?[\d,]+(\.\d{1,2})?\s*$/.test(l))
    const listing = {
      fbId: extractFbId(url),
      title: raw.bodyLines.find((l) => l.length > 8 && !/\$/.test(l)) ?? raw.bodyLines[0],
      priceCents: priceLine ? Number(priceLine.replace(/[^\d.]/g, '')) * 100 : 0,
      url,
      seenAt: Date.now(),
      ...detail,
    }

    const ev = await evaluateListing({
      listing, repo, config, sold, browse,
      identifier: ({ listing: l }) => identify({ listing: l, repo, llm, config }),
    })

    if (!ev.ok) {
      console.error(`\n  cannot value this listing: ${ev.error}\n`)
      process.exitCode = 1
      return
    }

    const { identity: id, compset: c, profit: p } = ev
    console.log(`\n  ${id.brand ?? ''} ${id.model ?? ''} ${id.variant ?? ''} ${id.capacity ?? ''}`.replace(/\s+/g, ' '))
    console.log(`  condition ${id.condition}, identified with ${pct(id.identityConfidence)} confidence\n`)
    console.log(`  seller asks       ${money(listing.priceCents)}`)
    console.log(`  OFFER UP TO       ${money(p.breakevenBuyCents)}`)
    console.log(`  sells for         ${money(c.trimmedMedianCents)}  (${c.sampleN} comps, ${money(c.p25Cents)}-${money(c.p75Cents)})`)
    console.log(`  net at ask        ${money(p.netCents)}  roi ${p.roi == null ? 'n/a' : pct(p.roi)}`)
    console.log(`  fees              ${money(p.fvfCents + p.perOrderCents + p.promotedCents)}`)
    console.log(`  shipping          ${money(p.shippingCents)}  (${p.shippingBand}, ${p.weightLb}lb)`)
    console.log(`  buffer            ${money(p.bufferCents)}`)
    console.log(`  sell-through      ${pct(c.sellThrough)}  (${c.activeCount} active now)`)
    console.log(`\n  verdict           ${ev.passed ? 'BUY' : 'PASS'}`)
    for (const r of ev.rejections) console.log(`                    - ${r.reason}`)
    console.log('')
  },
```

- [ ] **Step 6: Verify against a real listing**

Run:

```bash
./fbay scan --watch macbooks --dry | head -5
./fbay price "<paste one item URL from the scan output>"
```

Expected: a full verdict block with an OFFER UP TO number. The identified brand and model must match the listing photos.

- [ ] **Step 7: Commit**

```bash
git add src/watch/runner.mjs src/cli.mjs test/runner.test.mjs
git commit -m "feat: pipeline orchestrator and the fbay price verdict command"
```

**Phase 4 complete.** The full pipeline works end to end on a single listing.

---

## Task 18: Telegram Deal Alerts

**Files:**
- Create: `src/notify/telegram.mjs`
- Test: `test/telegram.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/telegram.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDealCard, createTelegramNotifier, escapeMd } from '../src/notify/telegram.mjs'

const DEAL = {
  listing: { title: 'MacBook Air 13 2019', priceCents: 12000, url: 'https://fb/1', city: 'Brooklyn, NY', imageUrls: ['https://img/1.jpg'] },
  identity: { brand: 'Apple', model: 'MacBook Air', variant: '13', capacity: '256GB', condition: 'good', identityConfidence: 0.9, category: 'laptop' },
  compset: { trimmedMedianCents: 30000, p25Cents: 28000, p75Cents: 32000, sampleN: 10, activeCount: 12, sellThrough: 0.45, confidence: 0.8 },
  profit: { netCents: 11945, roi: 0.995, breakevenBuyCents: 23945, shippingCents: 1650, fvfCents: 3975, perOrderCents: 30, promotedCents: 0, bufferCents: 1500 },
  score: 0.72,
}

// Note: the card is MarkdownV2, so "." is backslash-escaped in the output.
// These patterns match the escaped form on purpose. Asserting on the unescaped
// text would pass against a card that Telegram then rejects with a 400.
test('the card leads with the offer ceiling, because that is the actionable number', () => {
  const text = formatDealCard(DEAL)
  const firstNumberLine = text.split('\n').find((l) => /\$/.test(l))
  assert.match(firstNumberLine, /Offer up to/i)
  assert.match(firstNumberLine, /\$239\\\.45/)
})

test('the card includes net, roi, sell-through and comp count', () => {
  const text = formatDealCard(DEAL)
  assert.match(text, /\$119\\\.45/)
  assert.match(text, /100%/)          // roi
  assert.match(text, /45%/)           // sell-through
  assert.match(text, /10 comps/)
})

test('the card includes the listing link', () => {
  assert.match(formatDealCard(DEAL), /https:\/\/fb\/1/)
})

test('a price drop is called out', () => {
  const text = formatDealCard({ ...DEAL, priceDrop: { previousPriceCents: 20000, currentPriceCents: 12000 } })
  assert.match(text, /dropped/i)
  assert.match(text, /\$200\\\.00/)
})

test('escapeMd escapes MarkdownV2 reserved characters', () => {
  assert.equal(escapeMd('a-b.c(d)'), 'a\\-b\\.c\\(d\\)')
})

test('the notifier sends a photo when an image is available', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push({ u: String(u), o }); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyDeal(DEAL)
  assert.match(calls[0].u, /sendPhoto/)
  assert.equal(JSON.parse(calls[0].o.body).photo, 'https://img/1.jpg')
})

test('the notifier falls back to sendMessage with no image', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push({ u: String(u), o }); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyDeal({ ...DEAL, listing: { ...DEAL.listing, imageUrls: [] } })
  assert.match(calls[0].u, /sendMessage/)
})

test('a photo send failure falls back to a text message rather than losing the alert', async () => {
  const calls = []
  const n = createTelegramNotifier({
    token: 't', chatId: '1',
    fetchImpl: async (u, o) => {
      calls.push(String(u))
      if (String(u).includes('sendPhoto')) return { ok: false, status: 400, text: async () => 'bad photo' }
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  const r = await n.notifyDeal(DEAL)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /sendMessage/)
})

test('notifyAlert sends an operational warning', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyAlert('eBay sold parser returned zero results')
  assert.match(calls[0].text, /parser returned zero/)
})

test('a missing token disables the notifier instead of crashing the run', async () => {
  const n = createTelegramNotifier({ token: null, chatId: null })
  const r = await n.notifyDeal(DEAL)
  assert.equal(r.ok, false)
  assert.match(r.error, /not configured/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/telegram.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/notify/telegram.mjs**

```js
const MD_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g

export function escapeMd (s) {
  return String(s ?? '').replace(MD_RESERVED, (c) => `\\${c}`)
}

function money (cents) {
  return cents == null ? 'n/a' : `$${(cents / 100).toFixed(2)}`
}

function pct (x) {
  return x == null ? 'n/a' : `${Math.round(x * 100)}%`
}

export function formatDealCard ({ listing, identity, compset, profit, score, priceDrop }) {
  const name = [identity.brand, identity.model, identity.variant, identity.capacity].filter(Boolean).join(' ')
  const lines = [
    `*${escapeMd(name || listing.title)}*`,
    escapeMd(`${identity.condition} · ${identity.category} · ${pct(identity.identityConfidence)} sure`),
    '',
    escapeMd(`Offer up to ${money(profit.breakevenBuyCents)}   (asking ${money(listing.priceCents)})`),
    escapeMd(`Net ${money(profit.netCents)} · ROI ${pct(profit.roi)} · score ${score.toFixed(2)}`),
    '',
    escapeMd(`Sells for ${money(compset.trimmedMedianCents)} (${money(compset.p25Cents)}-${money(compset.p75Cents)}, ${compset.sampleN} comps)`),
    escapeMd(`Sell-through ${pct(compset.sellThrough)} · ${compset.activeCount} active`),
    escapeMd(`Fees ${money(profit.fvfCents + profit.perOrderCents + profit.promotedCents)} · ship ${money(profit.shippingCents)} · buffer ${money(profit.bufferCents)}`),
  ]
  if (priceDrop) {
    lines.splice(3, 0, escapeMd(`Price dropped from ${money(priceDrop.previousPriceCents)}`), '')
  }
  if (listing.city) lines.push(escapeMd(listing.city))
  lines.push('', escapeMd(listing.url))
  return lines.join('\n')
}

export function createTelegramNotifier ({
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl = globalThis.fetch,
} = {}) {
  const configured = Boolean(token && chatId)
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`

  async function send (method, body) {
    const res = await fetchImpl(api(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, error: `telegram ${method} failed: ${res.status} ${await res.text()}` }
    return { ok: true }
  }

  async function notifyDeal (deal) {
    if (!configured) return { ok: false, error: 'telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' }
    const text = formatDealCard(deal)
    const photo = (deal.listing.imageUrls ?? [])[0]

    if (photo) {
      const r = await send('sendPhoto', { chat_id: chatId, photo, caption: text, parse_mode: 'MarkdownV2' })
      if (r.ok) return r
      // A dead image URL must not cost us the alert.
    }
    return send('sendMessage', { chat_id: chatId, text, parse_mode: 'MarkdownV2', disable_web_page_preview: false })
  }

  async function notifyAlert (message) {
    if (!configured) return { ok: false, error: 'telegram not configured' }
    return send('sendMessage', { chat_id: chatId, text: escapeMd(`FBAY ALERT: ${message}`), parse_mode: 'MarkdownV2' })
  }

  return { configured, notifyDeal, notifyAlert }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/telegram.test.mjs`
Expected: `# pass 10`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/notify/telegram.mjs test/telegram.test.mjs
git commit -m "feat: telegram deal cards leading with the offer ceiling"
```

---

## Task 19: Drafted Seller Offer Messages

**Files:**
- Create: `src/notify/draft.mjs`
- Modify: `src/cli.mjs`
- Test: `test/draft.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/draft.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offerPriceCents, buildDraftPrompt, draftOffer, DRAFT_SYSTEM } from '../src/notify/draft.mjs'

const CTX = {
  listing: { title: 'MacBook Air 13 2019', priceCents: 20000, city: 'Brooklyn, NY' },
  identity: { brand: 'Apple', model: 'MacBook Air', condition: 'good' },
  profit: { breakevenBuyCents: 23945, netCents: 3945 },
}

test('the offer sits below the ask and never above breakeven', () => {
  const o = offerPriceCents({ askCents: 20000, breakevenBuyCents: 23945, discount: 0.2 })
  assert.ok(o < 20000)
  assert.ok(o <= 23945)
  assert.equal(o % 500, 0, 'offers should land on a clean $5 increment')
})

test('the offer is capped at breakeven when the ask is already above it', () => {
  const o = offerPriceCents({ askCents: 40000, breakevenBuyCents: 23945, discount: 0.2 })
  assert.ok(o <= 23945)
})

test('the offer never goes below a floor fraction of the ask', () => {
  const o = offerPriceCents({ askCents: 10000, breakevenBuyCents: 90000, discount: 0.9, minFraction: 0.6 })
  assert.ok(o >= 6000)
})

test('the prompt carries the ask, the offer and the item', () => {
  const p = buildDraftPrompt({ ...CTX, offerCents: 16000 })
  assert.match(p, /\$200/)
  assert.match(p, /\$160/)
  assert.match(p, /MacBook Air/)
})

test('the system prompt forbids mentioning resale', () => {
  assert.match(DRAFT_SYSTEM, /never mention/i)
  assert.match(DRAFT_SYSTEM, /resell|resale|eBay/i)
})

test('draftOffer returns the message and the offer price', async () => {
  const llm = { completeText: async () => ({ ok: true, text: 'Hi, is this still available? Could you do $160 cash, I can pick up today.' }) }
  const r = await draftOffer({ ...CTX, llm })
  assert.equal(r.ok, true)
  assert.match(r.body, /160/)
  assert.ok(r.offerCents < 20000)
})

test('draftOffer strips surrounding quotes the model sometimes adds', async () => {
  const llm = { completeText: async () => ({ ok: true, text: '"Hi, is this available?"' }) }
  const r = await draftOffer({ ...CTX, llm })
  assert.equal(r.body, 'Hi, is this available?')
})

test('an llm failure falls back to a usable template rather than no message', async () => {
  const llm = { completeText: async () => ({ ok: false, error: 'down' }) }
  const r = await draftOffer({ ...CTX, llm })
  assert.equal(r.ok, true)
  assert.equal(r.fallback, true)
  assert.match(r.body, /still available/i)
  assert.match(r.body, /\$\d/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/draft.test.mjs`
Expected: FAIL, module not found

- [ ] **Step 3: Implement src/notify/draft.mjs**

```js
export const DRAFT_SYSTEM = `You write short messages to Facebook Marketplace sellers as an ordinary local buyer.

Rules:
- Two sentences maximum. Marketplace sellers ignore paragraphs.
- Open by confirming availability, then make the offer as a specific number.
- Give one plain, human reason for the number: cash today, can collect this evening, saw similar ones around that price. One reason, not three.
- Sound like a person texting, not a business. No greetings like "Dear", no sign-off, no exclamation marks.
- Never mention resale, reselling, eBay, flipping, profit, or that you value the item higher than they do. That kills the deal instantly.
- Never claim a fault you have not seen. Do not invent damage as a negotiating lever.
- Output only the message text. No quotes around it, no preamble, no explanation.`

/** Round down to a clean $5 increment. Odd numbers read as calculated and invite haggling. */
function roundToFive (cents) {
  return Math.floor(cents / 500) * 500
}

export function offerPriceCents ({ askCents, breakevenBuyCents, discount = 0.2, minFraction = 0.6 }) {
  const target = askCents * (1 - discount)
  const floor = askCents * minFraction
  const capped = Math.min(target, breakevenBuyCents ?? target)
  return Math.max(roundToFive(Math.max(capped, floor)), 100)
}

export function buildDraftPrompt ({ listing, identity, offerCents }) {
  const d = (c) => `$${Math.round(c / 100)}`
  return [
    `Item: ${[identity.brand, identity.model].filter(Boolean).join(' ') || listing.title}`,
    `Listing title: ${listing.title}`,
    `They are asking: ${d(listing.priceCents)}`,
    `Offer this amount: ${d(offerCents)}`,
    listing.city ? `Location: ${listing.city}` : null,
    '',
    'Write the message.',
  ].filter(Boolean).join('\n')
}

function stripQuotes (s) {
  return String(s).trim().replace(/^["'`]+|["'`]+$/g, '').trim()
}

export async function draftOffer ({ listing, identity, profit, llm, discount = 0.2 }) {
  const offerCents = offerPriceCents({
    askCents: listing.priceCents,
    breakevenBuyCents: profit.breakevenBuyCents,
    discount,
  })

  const res = await llm.completeText({
    system: DRAFT_SYSTEM,
    user: buildDraftPrompt({ listing, identity, offerCents }),
    maxTokens: 200,
  })

  if (!res.ok) {
    return {
      ok: true,
      fallback: true,
      offerCents,
      body: `Hi, is this still available? I could do $${Math.round(offerCents / 100)} cash and collect today if that works.`,
    }
  }

  return { ok: true, fallback: false, offerCents, body: stripQuotes(res.text) }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/draft.test.mjs`
Expected: `# pass 8`, `# fail 0`

- [ ] **Step 5: Add the `deals` and `message` commands to src/cli.mjs**

Add these imports:

```js
import { draftOffer } from './notify/draft.mjs'
```

Add these commands:

```js
  async deals (args) {
    const { repo } = buildContext()
    const statusIdx = args.indexOf('--status')
    const status = statusIdx !== -1 ? args[statusIdx + 1] : (args.includes('--rejected') ? 'passed' : 'alerted')
    const rows = repo.listDeals({ status, limit: 30 })
    if (!rows.length) { console.log(`no deals with status "${status}"`); return }
    for (const d of rows) {
      console.log(`\n  #${d.id}  ${d.title.slice(0, 58)}`)
      console.log(`      ask ${money(d.ask_cents)}  offer up to ${money(d.breakeven_buy_cents)}  net ${money(d.net_profit_cents)}  roi ${pct(d.roi)}  score ${d.score?.toFixed(2) ?? 'n/a'}`)
      console.log(`      ${d.url}`)
      if (d.rejections) for (const r of JSON.parse(d.rejections)) console.log(`      - ${r.reason}`)
      if (d.error) console.log(`      ! ${d.error}`)
    }
    console.log('')
  },

  async message (args) {
    const id = Number(args[0])
    if (!id) { console.error('usage: fbay message <deal_id>'); process.exitCode = 1; return }
    const { repo } = buildContext()
    const deal = repo.listDeals({ limit: 1000 }).find((d) => d.id === id)
    if (!deal) { console.error(`no deal #${id}`); process.exitCode = 1; return }

    const identityRow = repo.db.prepare('SELECT * FROM identities WHERE identity_key = ? LIMIT 1').get(deal.identity_key) ?? {}
    const llm = createLlmClient()
    const r = await draftOffer({
      listing: { title: deal.title, priceCents: deal.ask_cents, city: null },
      identity: { brand: identityRow.brand, model: identityRow.model, condition: identityRow.condition },
      profit: { breakevenBuyCents: deal.breakeven_buy_cents },
      llm,
    })
    repo.saveMessage({ dealId: id, body: r.body, offerCents: r.offerCents })
    console.log(`\n  offering ${money(r.offerCents)}${r.fallback ? '  (template fallback)' : ''}\n`)
    console.log(`  ${r.body}\n`)
    console.log(`  ${deal.url}\n`)
  },

  async status (args) {
    const [id, newStatus] = args
    if (!id || !newStatus) { console.error('usage: fbay status <deal_id> <pursuing|bought|passed>'); process.exitCode = 1; return }
    const { repo } = buildContext()
    repo.setDealStatus(Number(id), newStatus)
    console.log(`deal #${id} -> ${newStatus}`)
  },
```

- [ ] **Step 6: Commit**

```bash
git add src/notify/draft.mjs src/cli.mjs test/draft.test.mjs
git commit -m "feat: drafted seller offers with breakeven-capped pricing"
```

---

## Task 20: Canaries, Doctor and the Scheduled Run Loop

**Files:**
- Create: `src/watch/canary.mjs`, `src/watch/schedule.mjs`
- Modify: `src/cli.mjs`
- Test: `test/canary.test.mjs`, `test/schedule.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/canary.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'
import { CANARIES, runCanary, runAllCanaries, scanningShouldHalt } from '../src/watch/canary.mjs'

const CANARY = CANARIES[0]

function soldWith (comps, strategy = 's-card') {
  return { fetchSold: async () => ({ ok: true, strategy, comps }) }
}

const OK_COMPS = Array.from({ length: 25 }, (_, i) => ({ title: 'Apple iPhone 13 128GB Unlocked', priceCents: 25000 + i * 100, soldAt: 1 }))

test('a healthy canary passes and resets the failure count', async () => {
  const repo = createRepo(openDb(':memory:'))
  repo.recordCanary(CANARY.name, false, 1)
  const r = await runCanary({ canary: CANARY, sold: soldWith(OK_COMPS), repo, now: 100 })
  assert.equal(r.ok, true)
  assert.equal(repo.getCanary(CANARY.name).consecutive_failures, 0)
})

test('zero results fails the canary with a drift reason', async () => {
  const repo = createRepo(openDb(':memory:'))
  const r = await runCanary({ canary: CANARY, sold: soldWith([], null), repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no selector strategy|zero results/i)
  assert.equal(repo.getCanary(CANARY.name).consecutive_failures, 1)
})

test('too few results fails the canary', async () => {
  const repo = createRepo(openDb(':memory:'))
  const r = await runCanary({ canary: CANARY, sold: soldWith(OK_COMPS.slice(0, 2)), repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /only 2/)
})

test('a median outside the sanity band fails the canary', async () => {
  const repo = createRepo(openDb(':memory:'))
  const absurd = OK_COMPS.map((c) => ({ ...c, priceCents: 5 }))
  const r = await runCanary({ canary: CANARY, sold: soldWith(absurd), repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /median/i)
})

test('a fetch error fails the canary without throwing', async () => {
  const repo = createRepo(openDb(':memory:'))
  const sold = { fetchSold: async () => ({ ok: false, error: 'ebay 503' }) }
  const r = await runCanary({ canary: CANARY, sold, repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /503/)
})

test('two consecutive failures halt scanning', () => {
  const repo = createRepo(openDb(':memory:'))
  repo.recordCanary(CANARY.name, false, 1)
  assert.equal(scanningShouldHalt(repo), false)
  repo.recordCanary(CANARY.name, false, 2)
  assert.equal(scanningShouldHalt(repo), true)
})

test('runAllCanaries alerts once with a combined message', async () => {
  const repo = createRepo(openDb(':memory:'))
  const alerts = []
  const r = await runAllCanaries({ sold: soldWith([], null), repo, notifier: { notifyAlert: async (m) => alerts.push(m) }, now: 1 })
  assert.equal(r.ok, false)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /canary/i)
})
```

Create `test/schedule.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuietHour, dueWatches, jitterMs } from '../src/watch/schedule.mjs'

test('quiet hours wrapping midnight are handled', () => {
  const q = { start: 23, end: 7 }
  assert.equal(isQuietHour(23, q), true)
  assert.equal(isQuietHour(2, q), true)
  assert.equal(isQuietHour(7, q), false)
  assert.equal(isQuietHour(12, q), false)
})

test('non-wrapping quiet hours are handled', () => {
  const q = { start: 1, end: 5 }
  assert.equal(isQuietHour(3, q), true)
  assert.equal(isQuietHour(23, q), false)
})

test('quiet hours are disabled when start equals end', () => {
  assert.equal(isQuietHour(3, { start: 0, end: 0 }), false)
})

test('dueWatches returns only enabled watches past their interval', () => {
  const now = 1000 * 60 * 60
  const watches = [
    { name: 'a', enabled: 1, interval_minutes: 30, last_run_at: now - 31 * 60000 },
    { name: 'b', enabled: 1, interval_minutes: 30, last_run_at: now - 5 * 60000 },
    { name: 'c', enabled: 0, interval_minutes: 1, last_run_at: 0 },
    { name: 'd', enabled: 1, interval_minutes: 60, last_run_at: null },
  ]
  assert.deepEqual(dueWatches(watches, now).map((w) => w.name), ['a', 'd'])
})

test('dueWatches shuffles order so the traffic pattern is not periodic', () => {
  const now = 1e9
  const watches = Array.from({ length: 8 }, (_, i) => ({ name: String(i), enabled: 1, interval_minutes: 1, last_run_at: 0 }))
  const a = dueWatches(watches, now, () => 0.9).map((w) => w.name).join()
  const b = dueWatches(watches, now, () => 0.1).map((w) => w.name).join()
  assert.notEqual(a, b)
})

test('jitter stays within the requested fraction', () => {
  for (const r of [0, 0.5, 1]) {
    const j = jitterMs(60000, 0.25, () => r)
    assert.ok(j >= 45000 && j <= 75000)
  }
})
```

- [ ] **Step 2: Run to verify both fail**

Run: `node --test test/canary.test.mjs test/schedule.test.mjs`
Expected: FAIL, modules not found

- [ ] **Step 3: Implement src/watch/canary.mjs**

```js
import { buildCompSet } from '../comps/stats.mjs'

/**
 * Known-good queries with expected outcomes. If eBay changes its markup, these
 * fail loudly. Without them, a broken parser looks identical to a quiet market,
 * which is the single most expensive failure mode this system has.
 * Bands are deliberately wide: they catch "the parser is broken", not price drift.
 */
export const CANARIES = [
  { name: 'ebay_sold_iphone', query: 'iphone 13 128gb unlocked', mustTokens: ['iphone', '13'], minResults: 8, medianBandCents: [8000, 70000] },
  { name: 'ebay_sold_airpods', query: 'apple airpods pro 2nd generation', mustTokens: ['airpods'], minResults: 8, medianBandCents: [4000, 25000] },
]

export const HALT_AFTER_CONSECUTIVE_FAILURES = 2

export async function runCanary ({ canary, sold, repo, now = Date.now() }) {
  const res = await sold.fetchSold(canary.query)

  if (!res.ok) {
    const reason = `fetch failed: ${res.error}`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  if (!res.strategy || res.comps.length === 0) {
    const reason = 'no selector strategy matched (zero results) - eBay markup has probably drifted'
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  const cs = buildCompSet({ soldComps: res.comps, activeCount: 0, mustTokens: canary.mustTokens, now, minSampleSize: canary.minResults })

  if (cs.sampleN < canary.minResults) {
    const reason = `only ${cs.sampleN} usable comps, expected at least ${canary.minResults}`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  const [lo, hi] = canary.medianBandCents
  if (cs.trimmedMedianCents < lo || cs.trimmedMedianCents > hi) {
    const reason = `median $${(cs.trimmedMedianCents / 100).toFixed(2)} outside sanity band $${lo / 100}-$${hi / 100} - prices are being misparsed`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  repo.recordCanary(canary.name, true, now, null)
  return { ok: true, name: canary.name, sampleN: cs.sampleN, medianCents: cs.trimmedMedianCents, strategy: res.strategy }
}

export async function runAllCanaries ({ sold, repo, notifier, now = Date.now() }) {
  const results = []
  for (const c of CANARIES) results.push(await runCanary({ canary: c, sold, repo, now }))
  const failed = results.filter((r) => !r.ok)
  if (failed.length && notifier) {
    await notifier.notifyAlert(`canary failure - ${failed.map((f) => `${f.name}: ${f.reason}`).join(' | ')}`)
  }
  return { ok: failed.length === 0, results, failed }
}

export function scanningShouldHalt (repo) {
  return CANARIES.some((c) => (repo.getCanary(c.name)?.consecutive_failures ?? 0) >= HALT_AFTER_CONSECUTIVE_FAILURES)
}
```

- [ ] **Step 4: Implement src/watch/schedule.mjs**

```js
export function isQuietHour (hour, { start, end }) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

export function jitterMs (baseMs, fraction = 0.25, rng = Math.random) {
  return Math.round(baseMs * (1 + (rng() * 2 - 1) * fraction))
}

/** Shuffled so a watcher on the other side cannot fingerprint a fixed rotation. */
export function dueWatches (watches, now, rng = Math.random) {
  const due = watches.filter((w) => {
    if (!w.enabled) return false
    if (!w.last_run_at) return true
    return now - w.last_run_at >= w.interval_minutes * 60000
  })
  return due
    .map((w) => ({ w, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.w)
}

export async function runLoop ({
  repo, config, notifier, runOne,
  clock = Date.now,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  tickMs = 5 * 60000,
  shouldContinue = () => true,
  logger = console,
}) {
  while (shouldContinue()) {
    const now = clock()
    const hour = new Date(now).getHours()

    if (isQuietHour(hour, config.quietHours)) {
      logger.log(`quiet hours (${hour}:00), sleeping`)
      await sleepImpl(jitterMs(tickMs))
      continue
    }

    const due = dueWatches(repo.listWatches(), now)
    if (!due.length) {
      await sleepImpl(jitterMs(tickMs))
      continue
    }

    for (const watch of due) {
      const r = await runOne(watch)
      logger.log(`[${watch.name}] ${r.ok ? `${r.listingsSeen} seen, ${r.listingsNew} new, ${r.dealsFound} deals` : `failed: ${r.error}`}`)
      if (!r.ok && r.kind) {
        await notifier.notifyAlert(`scan halted on watch "${watch.name}": ${r.error}`)
        break
      }
    }

    await sleepImpl(jitterMs(tickMs))
  }
}
```

- [ ] **Step 5: Run to verify the tests pass**

Run: `node --test test/canary.test.mjs test/schedule.test.mjs`
Expected: `# pass 13`, `# fail 0`

- [ ] **Step 6: Add the `doctor` and `run` commands to src/cli.mjs**

Add these imports:

```js
import { runAllCanaries, scanningShouldHalt } from './watch/canary.mjs'
import { runLoop } from './watch/schedule.mjs'
import { runWatch } from './watch/runner.mjs'
import { createTelegramNotifier } from './notify/telegram.mjs'
```

Add these commands:

```js
  async doctor () {
    const checks = []
    const { config, repo, browse, sold } = buildContext()

    const env = requireEnv(process.env, ['EBAY_APP_ID', 'EBAY_CERT_ID', 'ANTHROPIC_API_KEY'])
    checks.push({ check: 'env vars', ok: env.ok, detail: env.ok ? 'all set' : `missing ${env.missing.join(', ')}` })

    checks.push({ check: 'database', ok: true, detail: JSON.stringify(repo.stats()) })

    const tok = await browse.getToken()
    checks.push({ check: 'ebay oauth', ok: tok.ok, detail: tok.ok ? 'token acquired' : tok.error })

    const notifier = createTelegramNotifier()
    checks.push({ check: 'telegram', ok: notifier.configured, detail: notifier.configured ? 'configured' : 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing' })

    const canaries = await runAllCanaries({ sold, repo, notifier: null })
    for (const r of canaries.results) {
      checks.push({ check: `canary ${r.name}`, ok: r.ok, detail: r.ok ? `${r.sampleN} comps, median ${money(r.medianCents)}, strategy ${r.strategy}` : r.reason })
    }

    let fbOk = false
    let fbDetail = 'not checked'
    try {
      const session = await openSession({ headless: true })
      fbOk = await session.isLoggedIn()
      fbDetail = fbOk ? 'session valid' : 'not logged in - run: fbay login'
      await session.close()
    } catch (e) {
      fbDetail = e.message
    }
    checks.push({ check: 'facebook session', ok: fbOk, detail: fbDetail })

    checks.push({ check: 'scanning enabled', ok: !scanningShouldHalt(repo), detail: scanningShouldHalt(repo) ? 'HALTED by canary failures' : 'ok' })

    console.table(checks.map((c) => ({ check: c.check, status: c.ok ? 'ok' : 'FAIL', detail: c.detail })))
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1
  },

  async run () {
    const { config, repo, browse, sold } = buildContext()
    const llm = createLlmClient()
    const notifier = createTelegramNotifier()

    const canaries = await runAllCanaries({ sold, repo, notifier })
    if (!canaries.ok) console.warn('warning: canary failures detected, see fbay doctor')
    if (scanningShouldHalt(repo)) {
      console.error('scanning halted: canaries have failed repeatedly. fix the parser, then run fbay doctor.')
      process.exitCode = 1
      return
    }

    const session = await openSession({ headless: !process.env.FBAY_HEADED })
    const pacer = createPacer({ config: config.pace })
    const source = createFacebookSource({ session, pacer })

    console.log('fbay running. ctrl-c to stop.')
    await runLoop({
      repo, config, notifier,
      runOne: (watch) => runWatch({
        watch, source, repo, config, sold, browse, notifier,
        identifier: ({ listing }) => identify({ listing, repo, llm, config }),
      }),
    })
    await session.close()
  },

  async db (args) {
    const { repo } = buildContext()
    if (args[0] === 'prune') {
      const days = Number(args[1] ?? 180)
      repo.prune(Date.now() - days * 86400000)
      console.log(`pruned data older than ${days} days`)
      return
    }
    console.table(repo.stats())
  },
```

- [ ] **Step 7: Verify doctor against live services**

Run: `./fbay doctor`
Expected: a table where `ebay oauth`, both canaries, and `facebook session` all read `ok`. Any `FAIL` row names the exact fix.

- [ ] **Step 8: Run the whole suite and commit**

```bash
node --test test/*.test.mjs
git add src/watch src/cli.mjs test/canary.test.mjs test/schedule.test.mjs
git commit -m "feat: parser canaries, doctor diagnostics and the scheduled run loop"
```

**Phase 5 complete.** The system runs unattended and alerts on both deals and its own breakage.

---

## Task 21: Local Dashboard

**Files:**
- Create: `dashboard/package.json`, `dashboard/next.config.mjs`, `dashboard/app/layout.jsx`, `dashboard/app/page.jsx`, `dashboard/app/deal/[id]/page.jsx`, `dashboard/app/api/status/route.js`, `dashboard/lib/db.js`, `dashboard/app/globals.css`

The dashboard is read-mostly and opens the same SQLite file the engine writes. Status changes are the only write.

- [ ] **Step 1: Scaffold the app**

Run:

```bash
# The brackets MUST be quoted. Unquoted, zsh treats [id] as a glob and fails
# with "no matches found" before mkdir ever runs.
mkdir -p ~/fbay/dashboard/app/deal/'[id]' ~/fbay/dashboard/app/api/status ~/fbay/dashboard/lib
cd ~/fbay/dashboard
npm init -y >/dev/null
npm install next@15 react@19 react-dom@19 better-sqlite3@13
```

- [ ] **Step 2: Write dashboard/package.json scripts**

Replace the `scripts` block in `dashboard/package.json` with:

```json
  "scripts": {
    "dev": "next dev -p 3737",
    "build": "next build",
    "start": "next start -p 3737"
  },
```

- [ ] **Step 3: Create dashboard/next.config.mjs**

```js
export default {
  serverExternalPackages: ['better-sqlite3'],
  images: { unoptimized: true },
}
```

- [ ] **Step 4: Create dashboard/lib/db.js**

```js
import path from 'node:path'
import Database from 'better-sqlite3'

let db = null

export function getDb () {
  if (!db) {
    const p = process.env.FBAY_DB_PATH || path.join(process.cwd(), '..', 'data', 'fbay.db')
    db = new Database(p, { readonly: false, fileMustExist: true })
  }
  return db
}

export const money = (c) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`)
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)

export function listDeals ({ status = 'alerted', limit = 100 } = {}) {
  return getDb().prepare(`
    SELECT d.*, l.title, l.price_cents ask_cents, l.url, l.image_urls, l.city, l.fb_id
    FROM deals d JOIN listings l ON l.id = d.listing_id
    WHERE d.status = ? ORDER BY d.score DESC LIMIT ?
  `).all(status, limit)
}

export function statusCounts () {
  return getDb().prepare('SELECT status, COUNT(*) n FROM deals GROUP BY status ORDER BY n DESC').all()
}

export function getDeal (id) {
  return getDb().prepare(`
    SELECT d.*, l.title, l.price_cents ask_cents, l.url, l.image_urls, l.city, l.description, l.seller_name
    FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.id = ?
  `).get(id)
}

export function getIdentity (identityKey) {
  return getDb().prepare('SELECT * FROM identities WHERE identity_key = ? LIMIT 1').get(identityKey)
}

export function getComps (compsetId) {
  return getDb().prepare('SELECT * FROM comps WHERE compset_id = ? ORDER BY included DESC, price_cents').all(compsetId)
}

export function getCompSetRow (id) {
  return getDb().prepare('SELECT * FROM compsets WHERE id = ?').get(id)
}

export function setStatus (id, status) {
  getDb().prepare('UPDATE deals SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
}
```

- [ ] **Step 5: Create dashboard/app/globals.css**

```css
:root {
  --bg: #0d0f12;
  --card: #16191e;
  --line: #262b33;
  --text: #e6e9ee;
  --dim: #8b94a3;
  --good: #37d67a;
  --bad: #ef5350;
  --accent: #ffb547;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
}
a { color: inherit; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 20px; letter-spacing: -0.01em; margin: 0 0 4px; }
.sub { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
.tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
.tab { padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; text-decoration: none; color: var(--dim); }
.tab[data-on="1"] { background: var(--card); color: var(--text); border-color: #3a4250; }
.card { display: grid; grid-template-columns: 96px 1fr auto; gap: 16px; align-items: center;
  background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 10px; text-decoration: none; }
.card:hover { border-color: #3a4250; }
.card img { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; background: #0a0c0f; }
.title { font-weight: 600; margin-bottom: 4px; }
.meta { color: var(--dim); font-size: 13px; }
.nums { text-align: right; white-space: nowrap; }
.offer { font-size: 19px; font-weight: 700; color: var(--accent); }
.net { color: var(--good); font-size: 13px; }
.net[data-neg="1"] { color: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 500; }
tr[data-excluded="1"] { color: #5c6472; text-decoration: line-through; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.stat b { display: block; font-size: 18px; margin-top: 2px; }
.btns { display: flex; gap: 8px; margin: 20px 0; }
button { background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; font: inherit; cursor: pointer; }
button:hover { border-color: #3a4250; }
.reject { color: var(--bad); font-size: 13px; }
```

- [ ] **Step 6: Create dashboard/app/layout.jsx**

```jsx
import './globals.css'

export const metadata = { title: 'FBay' }

export default function RootLayout ({ children }) {
  return (
    <html lang="en">
      <body><div className="wrap">{children}</div></body>
    </html>
  )
}
```

- [ ] **Step 7: Create dashboard/app/page.jsx**

```jsx
import Link from 'next/link'
import { listDeals, statusCounts, money, pct } from '../lib/db'

export const dynamic = 'force-dynamic'

const TABS = ['alerted', 'pursuing', 'bought', 'passed', 'needs_review']

export default async function Home ({ searchParams }) {
  const sp = await searchParams
  const status = sp?.status ?? 'alerted'
  const deals = listDeals({ status })
  const counts = Object.fromEntries(statusCounts().map((r) => [r.status, r.n]))

  return (
    <>
      <h1>FBay</h1>
      <div className="sub">Marketplace buys worth flipping, ranked by expected net</div>

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} className="tab" data-on={t === status ? '1' : '0'} href={`/?status=${t}`}>
            {t.replace('_', ' ')} {counts[t] ? `(${counts[t]})` : ''}
          </Link>
        ))}
      </div>

      {deals.length === 0 && <div className="meta">Nothing here yet. Run <code>fbay run</code>.</div>}

      {deals.map((d) => {
        const img = d.image_urls ? JSON.parse(d.image_urls)[0] : null
        return (
          <Link key={d.id} className="card" href={`/deal/${d.id}`}>
            {img ? <img src={img} alt="" /> : <div className="card-img" style={{ width: 96, height: 96, background: '#0a0c0f', borderRadius: 8 }} />}
            <div>
              <div className="title">{d.title}</div>
              <div className="meta">
                asking {money(d.ask_cents)} · sells for {money(d.gross_cents)} · {d.city ?? 'unknown location'}
              </div>
              {d.error && <div className="reject">{d.error}</div>}
            </div>
            <div className="nums">
              <div className="offer">{money(d.breakeven_buy_cents)}</div>
              <div className="net" data-neg={d.net_profit_cents < 0 ? '1' : '0'}>
                net {money(d.net_profit_cents)} · {pct(d.roi)}
              </div>
              <div className="meta">score {d.score?.toFixed(2) ?? '—'}</div>
            </div>
          </Link>
        )
      })}
    </>
  )
}
```

- [ ] **Step 8: Create dashboard/app/deal/[id]/page.jsx**

```jsx
import Link from 'next/link'
import { getDeal, getIdentity, getComps, getCompSetRow, money, pct } from '../../../lib/db'
import StatusButtons from './StatusButtons'

export const dynamic = 'force-dynamic'

export default async function DealPage ({ params }) {
  const { id } = await params
  const d = getDeal(Number(id))
  if (!d) return <div>No such deal.</div>

  const identity = d.identity_key ? getIdentity(d.identity_key) : null
  const cs = d.compset_id ? getCompSetRow(d.compset_id) : null
  const comps = d.compset_id ? getComps(d.compset_id) : []
  const images = d.image_urls ? JSON.parse(d.image_urls) : []
  const rejections = d.rejections ? JSON.parse(d.rejections) : []

  return (
    <>
      <Link className="meta" href="/">← back</Link>
      <h1 style={{ marginTop: 12 }}>{d.title}</h1>
      <div className="sub">
        {identity ? `${identity.brand ?? ''} ${identity.model ?? ''} ${identity.variant ?? ''} ${identity.capacity ?? ''} · ${identity.condition} · identified ${pct(identity.identity_confidence)} sure` : 'not identified'}
      </div>

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16 }}>
        {images.map((src) => <img key={src} src={src} alt="" style={{ height: 160, borderRadius: 8 }} />)}
      </div>

      <div className="grid">
        <div className="stat">offer up to<b style={{ color: 'var(--accent)' }}>{money(d.breakeven_buy_cents)}</b></div>
        <div className="stat">seller asks<b>{money(d.ask_cents)}</b></div>
        <div className="stat">sells for<b>{money(d.gross_cents)}</b></div>
        <div className="stat">net at ask<b style={{ color: d.net_profit_cents >= 0 ? 'var(--good)' : 'var(--bad)' }}>{money(d.net_profit_cents)}</b></div>
        <div className="stat">roi<b>{pct(d.roi)}</b></div>
        <div className="stat">sell-through<b>{cs ? pct(cs.sell_through) : '—'}</b></div>
        <div className="stat">active listings<b>{cs?.active_count ?? '—'}</b></div>
        <div className="stat">confidence<b>{pct(d.confidence)}</b></div>
      </div>

      {rejections.length > 0 && (
        <div>
          <h3>Why this was not alerted</h3>
          {rejections.map((r, i) => <div key={i} className="reject">• {r.reason}</div>)}
        </div>
      )}

      <StatusButtons id={d.id} current={d.status} />

      <p><a href={d.url} target="_blank" rel="noreferrer">open on Facebook →</a></p>

      {d.description && <><h3>Listing description</h3><pre style={{ whiteSpace: 'pre-wrap', color: 'var(--dim)' }}>{d.description}</pre></>}

      <h3>Comps used ({comps.filter((c) => c.included).length} of {comps.length})</h3>
      <div className="meta">Struck-through rows were excluded. This is the evidence behind the valuation.</div>
      <table>
        <thead><tr><th>title</th><th>price</th><th>sold</th><th>excluded because</th></tr></thead>
        <tbody>
          {comps.map((c) => (
            <tr key={c.id} data-excluded={c.included ? '0' : '1'}>
              <td>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : c.title}</td>
              <td>{money(c.price_cents)}</td>
              <td>{c.sold_at ? new Date(c.sold_at).toISOString().slice(0, 10) : '—'}</td>
              <td className="meta">{c.exclude_reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
```

- [ ] **Step 9: Create dashboard/app/deal/[id]/StatusButtons.jsx**

```jsx
'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

const OPTIONS = ['pursuing', 'bought', 'passed', 'alerted']

export default function StatusButtons ({ id, current }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function set (status) {
    setBusy(true)
    await fetch('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="btns">
      {OPTIONS.map((o) => (
        <button key={o} disabled={busy || o === current} onClick={() => set(o)}>
          {o === current ? `● ${o}` : o}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 10: Create dashboard/app/api/status/route.js**

```js
import { setStatus } from '../../../lib/db'

const ALLOWED = new Set(['new', 'alerted', 'reviewing', 'pursuing', 'bought', 'passed', 'expired', 'needs_review'])

export async function POST (req) {
  const { id, status } = await req.json()
  if (!ALLOWED.has(status)) {
    return Response.json({ ok: false, error: 'invalid status' }, { status: 400 })
  }
  setStatus(Number(id), status)
  return Response.json({ ok: true })
}
```

- [ ] **Step 11: Run the dashboard and verify**

Run:

```bash
cd ~/fbay/dashboard && npm run dev
```

Then open `http://localhost:3737`.
Expected: the alerted deals list renders with offer ceilings. Clicking a deal shows its comp table with excluded rows struck through. Clicking `pursuing` moves it into that tab.

- [ ] **Step 12: Commit**

```bash
cd ~/fbay
echo "dashboard/node_modules/" >> .gitignore
echo "dashboard/.next/" >> .gitignore
git add dashboard .gitignore
git commit -m "feat: local dashboard with deal feed, comp evidence and status write-back"
```

---

## Task 22: README, Full-Pipeline Integration Test and Final Verification

**Files:**
- Create: `README.md`, `test/pipeline.test.mjs`

- [ ] **Step 1: Write the end-to-end integration test**

Create `test/pipeline.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'
import { runWatch } from '../src/watch/runner.mjs'
import { identify } from '../src/identify/extract.mjs'
import { createSoldClient } from '../src/comps/ebay-sold.mjs'
import { createFacebookSource } from '../src/source/facebook/index.mjs'
import { createPacer } from '../src/source/facebook/pace.mjs'
import { formatDealCard } from '../src/notify/telegram.mjs'
import { DEFAULTS } from '../src/config.mjs'

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/ebay-sold-iphone.html'), 'utf8')
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0)

// A fake browser session returning one obviously underpriced iPhone.
const fakeSession = {
  goto: async () => ({ url: 'https://www.facebook.com/marketplace/nyc/search', bodyText: 'Marketplace', block: { blocked: false, kind: null } }),
  scroll: async () => {},
  extractNodes: async () => ([
    { href: '/marketplace/item/777/', lines: ['$60', 'iPhone 13 128gb unlocked', 'Brooklyn, NY'] },
  ]),
  extractDetail: async () => ({
    bodyLines: ['$60', 'iPhone 13 128gb unlocked', 'Listed 2 hours ago in Brooklyn, NY', 'Description', 'Works fine, small scratch on back.', 'Seller information', 'Sam R', 'Local pickup only'],
    imageUrls: ['https://scontent.example/i.jpg'],
  }),
  close: async () => {},
}

const IDENTITY_DATA = {
  brand: 'Apple', model: 'iPhone 13', variant: '', capacity: '128GB', modelYear: 2021,
  category: 'phone', condition: 'good', identityConfidence: 0.91,
  query: 'apple iphone 13 128gb unlocked', mustTokens: ['iphone', '13'], weightLb: 1,
}

test('a full pipeline pass turns one fixture listing into an alerted deal', async () => {
  const repo = createRepo(openDb(':memory:'))
  const config = DEFAULTS

  const pacer = createPacer({ config: config.pace, clock: () => NOW, sleepImpl: async () => {}, rng: () => 0.1 })
  const source = createFacebookSource({ session: fakeSession, pacer, clock: () => NOW })

  const sold = createSoldClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => FIXTURE }) })
  const browse = { searchActive: async () => ({ ok: true, total: 40, items: [] }) }
  const llm = { extractStructured: async () => ({ ok: true, data: IDENTITY_DATA, usage: {}, model: 'test' }) }

  const alerts = []
  const notifier = { notifyDeal: async (d) => alerts.push(d), notifyAlert: async () => {} }

  const r = await runWatch({
    watch: { id: null, name: 'iphones', city: 'nyc', query: 'iphone 13' },
    source, repo, config, sold, browse, notifier, now: NOW,
    identifier: ({ listing }) => identify({ listing, repo, llm, config, imageFetcher: async () => null, now: NOW }),
  })

  assert.equal(r.ok, true)
  assert.equal(r.listingsSeen, 1)
  assert.equal(r.listingsNew, 1)
  assert.equal(r.dealsFound, 1, `expected 1 deal, got ${r.dealsFound}. errors: ${JSON.stringify(r.errors)}`)

  const [alert] = alerts
  assert.equal(alert.listing.priceCents, 6000)
  assert.ok(alert.profit.breakevenBuyCents > 6000, 'breakeven must exceed the ask for this to be a deal')
  assert.equal(alert.profit.netCents, alert.profit.breakevenBuyCents - 6000)
  assert.equal(alert.identity.brand, 'Apple')
  assert.ok(alert.compset.sampleN >= 5)

  // The persisted deal must match the alert exactly.
  const stored = repo.listDeals({ status: 'alerted' })[0]
  assert.equal(stored.net_profit_cents, alert.profit.netCents)
  assert.equal(stored.breakeven_buy_cents, alert.profit.breakevenBuyCents)

  // The card must render without throwing and must lead with the offer ceiling.
  const card = formatDealCard(alert)
  assert.match(card, /Offer up to/)
  assert.match(card, /iPhone 13/)
})

test('the same run twice produces exactly one alert', async () => {
  const repo = createRepo(openDb(':memory:'))
  const pacer = createPacer({ config: DEFAULTS.pace, clock: () => NOW, sleepImpl: async () => {}, rng: () => 0.1 })
  const source = createFacebookSource({ session: fakeSession, pacer, clock: () => NOW })
  const sold = createSoldClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => FIXTURE }) })
  const browse = { searchActive: async () => ({ ok: true, total: 40, items: [] }) }
  const llm = { extractStructured: async () => ({ ok: true, data: IDENTITY_DATA, usage: {}, model: 'test' }) }
  const alerts = []
  const notifier = { notifyDeal: async (d) => alerts.push(d), notifyAlert: async () => {} }
  const args = {
    watch: { id: null, name: 'iphones', city: 'nyc', query: 'iphone 13' },
    source, repo, config: DEFAULTS, sold, browse, notifier, now: NOW,
    identifier: ({ listing }) => identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null, now: NOW }),
  }
  await runWatch(args)
  await runWatch(args)
  assert.equal(alerts.length, 1)
})

test('an eBay outage marks the listing needs_review instead of dropping it', async () => {
  const repo = createRepo(openDb(':memory:'))
  const pacer = createPacer({ config: DEFAULTS.pace, clock: () => NOW, sleepImpl: async () => {}, rng: () => 0.1 })
  const source = createFacebookSource({ session: fakeSession, pacer, clock: () => NOW })
  const sold = { fetchSold: async () => ({ ok: false, error: 'ebay 503' }) }
  const browse = { searchActive: async () => ({ ok: true, total: 40, items: [] }) }
  const llm = { extractStructured: async () => ({ ok: true, data: IDENTITY_DATA, usage: {}, model: 'test' }) }

  const r = await runWatch({
    watch: { id: null, name: 'iphones', city: 'nyc', query: 'iphone 13' },
    source, repo, config: DEFAULTS, sold, browse, now: NOW,
    notifier: { notifyDeal: async () => {}, notifyAlert: async () => {} },
    identifier: ({ listing }) => identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null, now: NOW }),
  })

  assert.equal(r.dealsFound, 0)
  assert.equal(repo.countListings(), 1, 'the listing must still be recorded')
  assert.equal(repo.listDeals({ status: 'needs_review' }).length, 1)
})

test('a facebook block halts the run and reports the kind', async () => {
  const repo = createRepo(openDb(':memory:'))
  const blocked = { ...fakeSession, goto: async () => ({ url: 'https://www.facebook.com/checkpoint/1', bodyText: '', block: { blocked: true, kind: 'checkpoint' } }) }
  const pacer = createPacer({ config: DEFAULTS.pace, clock: () => NOW, sleepImpl: async () => {}, rng: () => 0.1 })
  const source = createFacebookSource({ session: blocked, pacer, clock: () => NOW })

  const r = await runWatch({
    watch: { id: null, name: 'x' }, source, repo, config: DEFAULTS,
    sold: { fetchSold: async () => ({ ok: true, strategy: 's', comps: [] }) },
    browse: { searchActive: async () => ({ ok: true, total: 0 }) },
    notifier: { notifyDeal: async () => {}, notifyAlert: async () => {} },
    identifier: async () => ({ ok: false, error: 'unused' }),
    now: NOW,
  })

  assert.equal(r.ok, false)
  assert.equal(r.kind, 'checkpoint')
  assert.equal(pacer.isCoolingDown(), true)
})
```

- [ ] **Step 2: Run the integration test**

Run: `node --test test/pipeline.test.mjs`
Expected: `# pass 4`, `# fail 0`

If `expected 1 deal, got 0` appears, read the printed `errors` array. The usual cause is the fixture's median iPhone price being high enough that the default `$30` profit floor is not met at a `$60` ask, which would be a fixture problem, not a code problem. Do not lower the threshold to make the test pass.

- [ ] **Step 3: Write README.md**

````markdown
# FBay

Finds underpriced Facebook Marketplace listings, values them against real eBay sold prices, and tells you the most you should offer.

## What it actually does

For every listing it finds:

1. Works out what the item is from the title, description and **photos** (a vision model, because "MacBook good condition" is not a search query).
2. Pulls eBay **sold** comps, throws out lots, parts units and outliers, and takes the trimmed median.
3. Computes sell-through (`sold / (sold + active)`). Below 30% it is not a deal at any price, it is inventory.
4. Subtracts eBay fees, shipping, and a 5% buffer to produce a **breakeven buy price**.
5. Alerts you on Telegram with that number, and drafts the message to send the seller.

## Setup

```bash
cd ~/fbay
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `EBAY_APP_ID`, `EBAY_CERT_ID` | developer.ebay.com → My Account → Application Keys → **Production** keyset. Free, about five minutes. |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Existing bot on this machine, or @BotFather |

Then log into Facebook once. A browser opens, you log in, the session persists:

```bash
./fbay login
./fbay doctor
```

`doctor` must be all green before you run anything else.

## Daily use

```bash
# Paste any Marketplace link, get a verdict
./fbay price "https://www.facebook.com/marketplace/item/123456789/"

# What does this sell for, and how fast
./fbay comps "dewalt dcd791 20v drill"

# Saved searches
./fbay watch add --name macbooks --city nyc --query "macbook pro" --max 900 --radius 40
./fbay watch list

# One pass now
./fbay scan --watch macbooks

# Run continuously, alerting to Telegram
./fbay run

# Review
./fbay deals
./fbay deals --status needs_review
./fbay message 42          # draft the seller offer
./fbay status 42 pursuing
```

Dashboard:

```bash
cd dashboard && npm run dev   # http://localhost:3737
```

## Tuning

Copy `config.example.json` to `config.json` and edit. Everything is optional, defaults are in `src/config.mjs`.

| Setting | Default | Meaning |
|---|---|---|
| `thresholds.minNetProfitCents` | 3000 | Do not alert below $30 net |
| `thresholds.minRoi` | 0.5 | Do not alert below 50% ROI |
| `thresholds.minSellThrough` | 0.30 | Do not alert on slow movers |
| `economics.bufferRate` | 0.05 | Haircut for returns, damage, misjudgement |
| `economics.promotedRate` | 0 | Set to ~0.03 if you promote listings |
| `freight.enabled` | false | Include furniture and appliances |
| `pace.maxListingsPerDay` | 600 | Facebook request budget |

## Why it will not silently rot

Scrapers usually die quietly: eBay changes a selector, comps return zero, and the system reports "no deals" forever while you assume the market is slow.

- `fbay doctor` runs **canary queries** with known-good expected results. Zero results, or a median outside a sanity band, fails loudly.
- Two consecutive canary failures **halt scanning** rather than producing garbage.
- A listing whose comps fail becomes `needs_review`, never a dropped row.
- A Facebook checkpoint or login wall stops the run immediately and starts an escalating cooldown.

## Account safety

Scraping Marketplace is against Facebook's terms. The realistic risk is a checkpoint on the account you use, not legal action. Pacing (`src/source/facebook/pace.mjs`) enforces an hourly request ceiling, a daily listing budget, human-shaped delays and shuffled watch order. **Use a secondary Facebook account.**

## Tests

```bash
node --test test/*.test.mjs
```

No live network. eBay parsing is asserted against a saved fixture in `test/fixtures/`.

## Architecture

```
source/facebook  →  identify  →  comps  →  economics  →  score  →  notify
   Playwright       vision LLM    eBay      pure math    pure math   Telegram
```

`economics` and `score` have zero I/O and are fully unit-tested. Every network stage parses through a pure function fed by fixtures. Only `db/repo.mjs` knows SQLite exists, so swapping in Supabase later touches one file.
````

- [ ] **Step 4: Full verification**

Run:

```bash
cd ~/fbay
node --test test/*.test.mjs
```

Expected: every test file passes, `# fail 0`. Record the total pass count.

Run:

```bash
./fbay doctor
```

Expected: exit code 0, all rows `ok`.

- [ ] **Step 5: Commit**

```bash
git add README.md test/pipeline.test.mjs
git commit -m "feat: end-to-end pipeline integration test and operator README"
```

---

## Spec Coverage Check

| Spec requirement | Task |
|---|---|
| Sold comps not asking prices | 9, 10 |
| Sell-through gate | 6, 7 |
| Vision-based identity with condition | 16 |
| Trimmed median, must-token filtering, lot exclusion | 6 |
| Breakeven buy price as the headline number | 5, 17, 18 |
| Category fee table | 3 |
| Shipping bands and freight flagging | 4 |
| Composite scoring with recorded rejection reasons | 7 |
| Dual cache keys (content hash, identity key) | 2, 16 |
| CompSet 7-day TTL | 2, 10 |
| Canary queries and loud drift alerts | 20 |
| No dropped rows (`needs_review`) | 17, 22 |
| Block detection and escalating cooldown | 11, 14 |
| Pacing: hourly ceiling, daily budget, shuffled order | 11, 20 |
| LLM cost control: caching plus one-shot escalation | 16 |
| Telegram deal cards and drafted offers | 18, 19 |
| Full CLI surface | 10, 14, 17, 19, 20 |
| Dashboard with comp evidence and status write-back | 21 |
| Fixture-driven tests, no live network | 9, 22 |
| Operator setup docs | 22 |
