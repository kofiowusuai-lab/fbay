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

import { createFacebookSource } from '../src/source/facebook/index.mjs'
import { createPacer } from '../src/source/facebook/pace.mjs'
import { DEFAULTS } from '../src/config.mjs'

function sessionWith (n) {
  return {
    goto: async () => ({ url: 'https://www.facebook.com/marketplace/nyc/search', bodyText: 'ok', block: { blocked: false, kind: null } }),
    scroll: async () => {},
    extractNodes: async () => Array.from({ length: n }, (_, i) => ({
      href: `/marketplace/item/${i}/`,
      lines: [`$${(n - i) * 100}`, `Item ${i}`, 'NY'],
      image: null,
    })),
    extractDetail: async () => ({ bodyLines: ['$1', 'x'], imageUrls: [] }),
  }
}

test('limit bounds the expensive detail fetches, not just the evaluation', async () => {
  let detailPages = 0
  const session = sessionWith(20)
  const origGoto = session.goto
  session.goto = async (url, opts) => { if (/item/.test(url)) detailPages++; return origGoto(url, opts) }

  const pacer = createPacer({ config: { ...DEFAULTS.pace, detailFetchRatio: 1 }, sleepImpl: async () => {}, rng: () => 0 })
  const source = createFacebookSource({ session, pacer })
  const r = await source.scan({ city: 'nyc', query: 'x' }, { fetchDetails: true, limit: 3 })

  assert.equal(r.listings.length, 3)
  assert.ok(detailPages <= 3, `expected at most 3 detail fetches, got ${detailPages}`)
})

test('limit keeps feed order (newest first), it does not sort by price', async () => {
  // Sorting by price sends a bounded budget to the bottom of the market, which
  // on Marketplace is boxes, cases and $1 bait listings. Feed order is
  // newest-first, and being early to a fresh listing is the actual edge.
  const pacer = createPacer({ config: { ...DEFAULTS.pace, detailFetchRatio: 0 }, sleepImpl: async () => {}, rng: () => 0 })
  const source = createFacebookSource({ session: sessionWith(10), pacer })
  const r = await source.scan({ city: 'nyc', query: 'x' }, { fetchDetails: true, limit: 3 })
  const prices = r.listings.map((l) => l.priceCents)
  assert.equal(prices[0], 100000, 'first item in the feed, not the cheapest')
  assert.notDeepEqual(prices, [...prices].sort((a, b) => a - b), 'must not be price-sorted')
})

test('no limit means every listing is still considered', async () => {
  const pacer = createPacer({ config: { ...DEFAULTS.pace, detailFetchRatio: 0 }, sleepImpl: async () => {}, rng: () => 0 })
  const source = createFacebookSource({ session: sessionWith(7), pacer })
  const r = await source.scan({ city: 'nyc', query: 'x' }, { fetchDetails: true })
  assert.equal(r.listings.length, 7)
})
