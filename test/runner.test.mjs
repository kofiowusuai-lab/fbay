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

test('a listing that has gone is never alerted', async () => {
  // The operator was getting Telegram cards for listings that showed
  // "This listing no longer exists" - an alert that cannot be acted on.
  const d = deps()
  const source = { scan: async () => ({ ok: true, listings: [LISTING], warnings: [] }) }
  const notified = []
  const deadSession = {
    goto: async () => ({ ok: true, bodyText: 'This listing no longer exists.', block: { blocked: false, kind: null } }),
  }
  const r = await runWatch({
    watch: { id: null, name: 'test', city: 'nyc', query: 'macbook' },
    source, notifier: { notifyDeal: async (x) => notified.push(x), notifyNearMiss: async (x) => notified.push(x) },
    liveSession: deadSession, ...d,
  })
  assert.equal(notified.length, 0, 'a dead listing must not reach Telegram')
  assert.equal(r.expired, 1)
  assert.equal(d.repo.listDeals({ status: 'expired' }).length, 1)
})

test('a live listing is still alerted', async () => {
  const d = deps()
  const source = { scan: async () => ({ ok: true, listings: [LISTING], warnings: [] }) }
  const notified = []
  const liveSession = {
    goto: async () => ({ ok: true, bodyText: 'MacBook Air 13\n$120\nMessage seller', block: { blocked: false, kind: null } }),
  }
  const r = await runWatch({
    watch: { id: null, name: 'test', city: 'nyc', query: 'macbook' },
    source, notifier: { notifyDeal: async (x) => notified.push(x), notifyNearMiss: async () => {} },
    liveSession, ...d,
  })
  assert.equal(r.dealsFound, 1)
  assert.equal(notified.length, 1)
})

test('with no session to check with, the deal is still sent', async () => {
  // Failing closed here would silently suppress every deal.
  const d = deps()
  const source = { scan: async () => ({ ok: true, listings: [LISTING], warnings: [] }) }
  const notified = []
  const r = await runWatch({
    watch: { id: null, name: 'test', city: 'nyc', query: 'macbook' },
    source, notifier: { notifyDeal: async (x) => notified.push(x), notifyNearMiss: async () => {} },
    liveSession: null, ...d,
  })
  assert.equal(r.dealsFound, 1)
  assert.equal(notified.length, 1)
})
