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
