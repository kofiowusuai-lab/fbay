import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fvfRate, perOrderFeeCents, computeFees, FEE_TABLE } from '../src/economics/fees.mjs'

test('unknown category falls back to the default rate', () => {
  assert.equal(fvfRate('nonexistent_category'), FEE_TABLE.default)
})

test('known category overrides the default rate', () => {
  assert.equal(fvfRate('athletic_shoes'), 0.08)
  assert.equal(fvfRate('books_movies_music'), 0.153)
})

test('per-order fee uses the sub-$10 band', () => {
  assert.equal(perOrderFeeCents(999), 40)
  assert.equal(perOrderFeeCents(1000), 30)
  assert.equal(perOrderFeeCents(50000), 30)
})

test('computeFees returns exact integer cents', () => {
  const f = computeFees({ grossCents: 30000, category: 'phone', promotedRate: 0 })
  assert.equal(f.fvfCents, 3975)   // 30000 * 0.1325
  assert.equal(f.perOrderCents, 30)
  assert.equal(f.promotedCents, 0)
  assert.equal(f.totalCents, 4005)
  assert.equal(Number.isInteger(f.totalCents), true)
})

test('computeFees applies the promoted-listing rate', () => {
  const f = computeFees({ grossCents: 10000, category: 'phone', promotedRate: 0.03 })
  assert.equal(f.promotedCents, 300)
  assert.equal(f.totalCents, 1325 + 30 + 300)
})

test('computeFees rounds half up on fractional cents', () => {
  const f = computeFees({ grossCents: 1001, category: 'phone', promotedRate: 0 })
  assert.equal(f.fvfCents, 133)  // 132.6325 -> 133
})
