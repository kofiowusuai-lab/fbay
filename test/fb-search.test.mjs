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
