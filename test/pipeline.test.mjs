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

// Captured live from eBay. NOTE: eBay geolocated the capture and returned
// Brazilian real prices, so the fixture currency is BRL. That is not a defect
// to paper over - it is the exact trap the currency guard exists to catch, and
// the tests below exercise both directions of it.
const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/ebay-cards-iphone.html'), 'utf8')
const FIXTURE_CURRENCY = 'BRL'
const MATCHING_CONFIG = { ...DEFAULTS, currency: FIXTURE_CURRENCY }
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
  const config = MATCHING_CONFIG

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
    identifier: ({ listing }) => identify({ listing, repo, llm, config: MATCHING_CONFIG, imageFetcher: async () => null, now: NOW }),
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
    source, repo, config: MATCHING_CONFIG, sold, browse, notifier, now: NOW,
    identifier: ({ listing }) => identify({ listing, repo, llm, config: MATCHING_CONFIG, imageFetcher: async () => null, now: NOW }),
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
    source, repo, config: MATCHING_CONFIG, sold, browse, now: NOW,
    notifier: { notifyDeal: async () => {}, notifyAlert: async () => {} },
    identifier: ({ listing }) => identify({ listing, repo, llm, config: MATCHING_CONFIG, imageFetcher: async () => null, now: NOW }),
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
    watch: { id: null, name: 'x', city: 'nyc', query: 'x' }, source, repo, config: MATCHING_CONFIG,
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

test('a currency mismatch blocks the deal end to end instead of mispricing it', async () => {
  const repo = createRepo(openDb(':memory:'))
  const pacer = createPacer({ config: DEFAULTS.pace, clock: () => NOW, sleepImpl: async () => {}, rng: () => 0.1 })
  const source = createFacebookSource({ session: fakeSession, pacer, clock: () => NOW })
  const sold = createSoldClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => FIXTURE }) })
  const browse = { searchActive: async () => ({ ok: true, total: 40, items: [] }) }
  const llm = { extractStructured: async () => ({ ok: true, data: IDENTITY_DATA, usage: {}, model: 'test' }) }
  const alerts = []

  // The fixture is BRL. Under a USD config those numbers would value a $60
  // phone against a ~R$1,300 median and look like a 20x return.
  const usdConfig = { ...DEFAULTS, currency: 'USD' }
  const r = await runWatch({
    watch: { id: null, name: 'iphones', city: 'nyc', query: 'iphone 13' },
    source, repo, config: usdConfig, sold, browse, now: NOW,
    notifier: { notifyDeal: async (d) => alerts.push(d), notifyAlert: async () => {} },
    identifier: ({ listing }) => identify({ listing, repo, llm, config: usdConfig, imageFetcher: async () => null, now: NOW }),
  })

  assert.equal(r.dealsFound, 0, 'a foreign-currency compset must never produce a deal')
  assert.equal(alerts.length, 0)
  const review = repo.listDeals({ status: 'needs_review' })
  assert.equal(review.length, 1)
  assert.match(review[0].error, /BRL/)
})
