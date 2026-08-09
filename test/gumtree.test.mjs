import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGumtreeCard, parseGumtreeCards, extractGumtreeId, parsePriceCents, buildGumtreeUrl } from '../src/source/gumtree/parse.mjs'

// Shape captured live from gumtree.com
const CARD = {
  href: '/p/rotary-hammers/dewalt-cordless-hammer-drill-/1515004655',
  lines: ['1', 'Dewalt Cordless Hammer Drill', 'Brand new Dewalt Cordless Hammer Drill bare unit', 'Aveley, Essex', '£170'],
  img: 'https://img.gumtree.com/x/y/86',
}

test('extractGumtreeId pulls the numeric id from a listing path', () => {
  assert.equal(extractGumtreeId('/p/rotary-hammers/dewalt-drill/1515004655'), '1515004655')
  assert.equal(extractGumtreeId('/search?q=dewalt'), null)
})

test('prices parse with the pound sign and thousands separators', () => {
  assert.equal(parsePriceCents('£170'), 17000)
  assert.equal(parsePriceCents('£1,500'), 150000)
  assert.equal(parsePriceCents('£99.99'), 9999)
  assert.equal(parsePriceCents('170'), null, 'a bare number is the image count, not a price')
})

test('a card parses into the same shape a Facebook listing produces', () => {
  const l = parseGumtreeCard(CARD)
  assert.equal(l.source, 'gumtree')
  assert.equal(l.title, 'Dewalt Cordless Hammer Drill')
  assert.equal(l.priceCents, 17000)
  assert.equal(l.city, 'Aveley, Essex')
  assert.equal(l.url, 'https://www.gumtree.com/p/rotary-hammers/dewalt-cordless-hammer-drill-/1515004655')
  assert.equal(l.imageUrls.length, 1)
})

test('the leading image count is never mistaken for the title', () => {
  // "4" is the photo count; a naive first-line read would title the item "4".
  const l = parseGumtreeCard({ ...CARD, lines: ['4', 'Huge dewalt bundle', 'desc here', 'Wembley, London', '£1,500'] })
  assert.equal(l.title, 'Huge dewalt bundle')
  assert.equal(l.priceCents, 150000)
})

test('ids are namespaced so gumtree and facebook cannot collide in the database', () => {
  assert.match(parseGumtreeCard(CARD).fbId, /^gt:/)
})

test('a card with no price is skipped rather than guessed at', () => {
  assert.equal(parseGumtreeCard({ ...CARD, lines: ['1', 'Dewalt drill', 'Wanted'] }), null)
})

test('duplicate listings are collapsed', () => {
  const out = parseGumtreeCards([CARD, CARD, { ...CARD, href: '/p/x/y/999888777' }])
  assert.equal(out.length, 2)
})

test('the search url carries location, distance and a price ceiling', () => {
  const u = buildGumtreeUrl({ query: 'dewalt', city: 'london', distanceMiles: 30, maxPriceCents: 10000 })
  assert.match(u, /q=dewalt/)
  assert.match(u, /search_location=london/)
  assert.match(u, /distance=30/)
  assert.match(u, /max_price=100/, 'price ceilings are pounds, not pence')
})

test('multi-word locations are slugified', () => {
  assert.match(buildGumtreeUrl({ query: 'x', city: 'Milton Keynes' }), /search_location=milton-keynes/)
})
