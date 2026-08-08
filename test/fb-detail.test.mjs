import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDetail, parseListedAt } from '../src/source/facebook/detail.mjs'

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0)

test('parseListedAt converts relative times to absolute timestamps', () => {
  assert.equal(parseListedAt('Listed 2 hours ago', NOW), NOW - 2 * 3600000)
  assert.equal(parseListedAt('Listed 3 days ago in Brooklyn, NY', NOW), NOW - 3 * 86400000)
  assert.equal(parseListedAt('Listed 45 minutes ago', NOW), NOW - 45 * 60000)
  assert.equal(parseListedAt('Listed a week ago', NOW), NOW - 7 * 86400000)
  assert.equal(parseListedAt('no time here', NOW), null)
})

test('parseDetail extracts description, seller, images and delivery', () => {
  const d = parseDetail({
    bodyLines: [
      '$250',
      'Apple MacBook Air 13 inch 2019',
      'Listed 2 hours ago in Brooklyn, NY',
      'Condition: Used - Good',
      'Description',
      'Barely used, comes with charger. 256gb ssd.',
      'Seller information',
      'Jane Doe',
      'Local pickup only',
    ],
    imageUrls: ['https://scontent.example/a.jpg', 'https://scontent.example/b.jpg'],
    now: NOW,
  })
  assert.match(d.description, /Barely used/)
  assert.equal(d.sellerName, 'Jane Doe')
  assert.equal(d.delivery, 'pickup')
  assert.equal(d.imageUrls.length, 2)
  assert.equal(d.listedAt, NOW - 2 * 3600000)
  assert.equal(d.condition, 'Used - Good')
})

test('shipping availability is detected', () => {
  const d = parseDetail({ bodyLines: ['$10', 'Thing', 'Shipping available'], imageUrls: [], now: NOW })
  assert.equal(d.delivery, 'shipping')
})

test('both delivery methods are detected', () => {
  const d = parseDetail({ bodyLines: ['$10', 'Thing', 'Shipping and local pickup'], imageUrls: [], now: NOW })
  assert.equal(d.delivery, 'both')
})

test('a missing description returns null instead of an empty string', () => {
  const d = parseDetail({ bodyLines: ['$10', 'Thing'], imageUrls: [], now: NOW })
  assert.equal(d.description, null)
})
