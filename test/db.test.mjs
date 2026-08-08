import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, migrate } from '../src/db/db.mjs'
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

test('migrate rebuilds a legacy compsets table with NOT NULL sell_through', () => {
  const db = openDb(':memory:')
  // Simulate the pre-fix schema.
  db.exec('PRAGMA foreign_keys = OFF; DROP TABLE comps; DROP TABLE compsets;')
  db.exec(`CREATE TABLE compsets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, identity_key TEXT NOT NULL, marketplace TEXT NOT NULL,
    trimmed_median_cents INTEGER, p25_cents INTEGER, p75_cents INTEGER, sample_n INTEGER NOT NULL,
    raw_n INTEGER NOT NULL, active_count INTEGER NOT NULL, sold_count INTEGER NOT NULL,
    sell_through REAL NOT NULL, sold_per_week REAL, days_of_supply REAL, confidence REAL NOT NULL,
    fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`)

  const before = db.prepare('PRAGMA table_info(compsets)').all()
  assert.equal(before.find((c) => c.name === 'sell_through').notnull, 1)

  const r = migrate(db)
  assert.equal(r.migrated, true)
  assert.deepEqual(r.rebuilt, ['compsets', 'comps'])

  const after = db.prepare('PRAGMA table_info(compsets)').all()
  assert.equal(after.find((c) => c.name === 'sell_through').notnull, 0, 'sell_through must accept null')
  assert.ok(after.some((c) => c.name === 'active_count_available'))
})

test('migrate is a no-op on a current schema', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db).migrated, false)
})

test('a null sell-through persists and reads back as null', () => {
  const repo = freshRepo()
  const { id } = repo.saveCompSet({
    identityKey: 'k9', marketplace: 'EBAY_US', trimmedMedianCents: 30000, p25Cents: 29000, p75Cents: 31000,
    sampleN: 8, rawN: 10, activeCount: 0, soldCount: 8, sellThrough: null, activeCountAvailable: false,
    soldPerWeek: 2, daysOfSupply: null, confidence: 0.6, fetchedAt: 1000, expiresAt: 9000,
  }, [])
  const row = repo.getFreshCompSet('k9', 2000)
  assert.equal(row.sell_through, null)
  assert.equal(row.active_count_available, 0)
  assert.ok(id)
})
