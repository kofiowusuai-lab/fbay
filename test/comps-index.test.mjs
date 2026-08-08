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

test('a browse failure still yields a valuation, but marks sell-through unknown', async () => {
  // The valuation (median sold) does not depend on the active count, so the
  // compset survives. Sell-through does depend on it, so it becomes null.
  // An earlier version of this test asserted sellThrough === 1 here - that
  // assertion WAS the bug: it made the sell-through gate a no-op whenever the
  // Browse API was down.
  const repo = createRepo(openDb(':memory:'))
  const browse = { searchActive: async () => ({ ok: false, error: 'rate limited' }) }
  const r = await getCompSet({ identity, repo, sold: fakeSold(SOLD), browse, config: DEFAULTS, now: 100 * DAY })
  assert.equal(r.ok, true)
  assert.ok(r.compset.trimmedMedianCents > 0, 'valuation is independent of the active count')
  assert.equal(r.compset.activeCount, 0)
  assert.equal(r.compset.sellThrough, null)
  assert.notEqual(r.compset.sellThrough, 1)
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

test('a currency mismatch is refused rather than converted with a guessed rate', async () => {
  const repo = createRepo(openDb(':memory:'))
  const sold = { fetchSold: async () => ({ ok: true, strategy: 's-card', comps: SOLD, currency: 'BRL' }) }
  const r = await getCompSet({ identity, repo, sold, browse: fakeBrowse(120), config: DEFAULTS, now: 100 * DAY })
  assert.equal(r.ok, false)
  assert.equal(r.currencyMismatch, true)
  assert.match(r.error, /BRL/)
  assert.equal(repo.getFreshCompSet('k1', 100 * DAY), undefined)
})

test('a matching currency passes through', async () => {
  const repo = createRepo(openDb(':memory:'))
  const sold = { fetchSold: async () => ({ ok: true, strategy: 's-card', comps: SOLD, currency: 'USD' }) }
  const r = await getCompSet({ identity, repo, sold, browse: fakeBrowse(120), config: DEFAULTS, now: 100 * DAY })
  assert.equal(r.ok, true)
})

test('a browse failure produces an unknown sell-through, not a free pass', async () => {
  const repo = createRepo(openDb(':memory:'))
  const browse = { searchActive: async () => ({ ok: false, error: 'ebay 401' }) }
  const r = await getCompSet({ identity, repo, sold: fakeSold(SOLD), browse, config: DEFAULTS, now: 100 * DAY })
  assert.equal(r.ok, true)
  assert.equal(r.compset.sellThrough, null)
  assert.equal(r.compset.activeCountAvailable, false)
  assert.ok(r.warnings.some((w) => /401/.test(w)))
})

test('the unknown-sell-through flag survives a round trip through the cache', async () => {
  const repo = createRepo(openDb(':memory:'))
  const browse = { searchActive: async () => ({ ok: false, error: 'ebay 401' }) }
  await getCompSet({ identity, repo, sold: fakeSold(SOLD), browse, config: DEFAULTS, now: 100 * DAY })
  const cached = await getCompSet({ identity, repo, sold: fakeSold(SOLD), browse, config: DEFAULTS, now: 100 * DAY + 1000 })
  assert.equal(cached.cached, true)
  assert.equal(cached.compset.sellThrough, null, 'a cached unknown must not resurrect as a pass')
  assert.equal(cached.compset.activeCountAvailable, false)
})
