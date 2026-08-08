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
