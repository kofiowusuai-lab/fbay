import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseSoldHtml, parsePrice, parsePriceCents, parseSoldDate, soldSearchUrl,
  createSoldClient, detectCurrency, cleanTitle, detectGate,
} from '../src/comps/ebay-sold.mjs'

// Captured live from eBay. This is an ACTIVE search page, not a sold page,
// because sold pages require a signed-in account (see detectGate). The card
// markup is identical between the two, which is what this fixture exercises.
// Sold-date parsing is covered directly by the parseSoldDate tests below.
const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/ebay-cards-iphone.html'), 'utf8')

test('parsePriceCents handles plain, comma, decimal and range prices', () => {
  assert.equal(parsePriceCents('$299.99'), 29999)
  assert.equal(parsePriceCents('$1,234.56'), 123456)
  assert.equal(parsePriceCents('$10.00 to $20.00'), 1000)  // low end of a range
  assert.equal(parsePriceCents('C $50.00'), 5000)
  assert.equal(parsePriceCents('nonsense'), null)
})

test('parsePrice reports the currency alongside the amount', () => {
  assert.deepEqual(parsePrice('$299.99'), { cents: 29999, currency: 'USD' })
  assert.deepEqual(parsePrice('R$ 1,249.09'), { cents: 124909, currency: 'BRL' })
  assert.deepEqual(parsePrice('£120.00'), { cents: 12000, currency: 'GBP' })
  assert.deepEqual(parsePrice('C $50.00'), { cents: 5000, currency: 'CAD' })
})

test('detectCurrency prefers the longest matching prefix', () => {
  // "R$" and "C $" both contain "$"; a naive check would call them USD and
  // value a R$1,249 phone as a $1,249 phone.
  assert.equal(detectCurrency('R$ 1,249.09'), 'BRL')
  assert.equal(detectCurrency('C $50.00'), 'CAD')
  assert.equal(detectCurrency('US $50.00'), 'USD')
  assert.equal(detectCurrency('$50.00'), 'USD')
  assert.equal(detectCurrency('50.00'), null)
})

test('parsePrice handles comma-decimal locales', () => {
  assert.equal(parsePrice('€1.234,56').cents, 123456)
  assert.equal(parsePrice('$1,234.56').cents, 123456)
})

test('cleanTitle strips eBay screen-reader and badge text', () => {
  assert.equal(cleanTitle('Apple iPhone 13 128GBOpens in a new window or tab'), 'Apple iPhone 13 128GB')
  assert.equal(cleanTitle('New ListingApple iPhone 13'), 'Apple iPhone 13')
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

test('detectGate recognises the sign-in wall on sold listings', () => {
  assert.equal(detectGate('', 'Sign in or Register | eBay').gated, true)
  assert.equal(detectGate('', 'Security Measure | eBay').gated, true)
  assert.match(detectGate('', 'Sign in or Register | eBay').reason, /ebay-login/)
  assert.equal(detectGate('<html>results</html>', 'iPhone 13 for sale | eBay').gated, false)
})

test('parseSoldHtml extracts real comps from the live fixture', () => {
  const r = parseSoldHtml(FIXTURE)
  assert.equal(r.strategy, 's-card')
  assert.ok(r.comps.length >= 25, `expected 25+ comps, got ${r.comps.length}`)
  for (const c of r.comps) {
    assert.ok(c.title.length > 3)
    assert.ok(Number.isInteger(c.priceCents) && c.priceCents > 0)
  }
})

test('parseSoldHtml reports the page currency so a caller can reject it', () => {
  const r = parseSoldHtml(FIXTURE)
  assert.ok(r.currency, 'every card carries a currency symbol')
  assert.equal(r.currencies.length, 1, 'a single page must not mix currencies')
})

test('titles from the fixture carry no screen-reader noise', () => {
  const r = parseSoldHtml(FIXTURE)
  assert.ok(!r.comps.some((c) => /opens in a new window/i.test(c.title)))
})

test('prices from the fixture are scoped to the price element, not any bold text', () => {
  const r = parseSoldHtml(FIXTURE)
  // "17+ sold" lives in a bold span next to the price. If the selector is too
  // wide it parses as 1700 cents and drags the median to the floor.
  assert.ok(!r.comps.some((c) => c.priceCents === 1700), 'sold-count text is being parsed as a price')
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

test('createSoldClient reports the sign-in gate instead of "no results"', async () => {
  const client = createSoldClient({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<title>Sign in or Register | eBay</title>' }),
  })
  const r = await client.fetchSold('x')
  assert.equal(r.ok, false)
  assert.equal(r.gated, true)
  assert.match(r.error, /signed-in/)
})

test('createSoldClient parses a successful response', async () => {
  const client = createSoldClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => FIXTURE }) })
  const r = await client.fetchSold('iphone 13')
  assert.equal(r.ok, true)
  assert.ok(r.comps.length >= 25)
})
