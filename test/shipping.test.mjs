import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bandForWeight, shippingFor, CATEGORY_WEIGHT_LB, WEIGHT_BANDS } from '../src/economics/shipping.mjs'

test('bandForWeight picks the first band whose ceiling covers the weight', () => {
  assert.equal(bandForWeight(0.5).key, 'letter')
  assert.equal(bandForWeight(1).key, 'letter')
  assert.equal(bandForWeight(1.01).key, 'small')
  assert.equal(bandForWeight(9).key, 'medium')
  assert.equal(bandForWeight(200).key, 'freight')
})

test('shippingFor uses the category default weight', () => {
  const s = shippingFor({ category: 'phone' })
  assert.equal(s.weightLb, CATEGORY_WEIGHT_LB.phone)
  assert.equal(s.freight, false)
  assert.equal(Number.isInteger(s.costCents), true)
})

test('an explicit weight overrides the category default', () => {
  const s = shippingFor({ category: 'phone', weightLb: 40 })
  assert.equal(s.band.key, 'oversize')
})

test('furniture is flagged as freight with no parcel cost', () => {
  const s = shippingFor({ category: 'furniture' })
  assert.equal(s.freight, true)
  assert.equal(s.costCents, null)
})

test('local pickup resale bypasses shipping entirely', () => {
  const s = shippingFor({ category: 'furniture', localResale: true })
  assert.equal(s.freight, false)
  assert.equal(s.costCents, 0)
})

test('unknown category falls back to the default weight, not a crash', () => {
  const s = shippingFor({ category: 'made_up' })
  assert.equal(s.weightLb, CATEGORY_WEIGHT_LB.default)
})

test('every band except freight has an integer cost', () => {
  for (const b of WEIGHT_BANDS) {
    if (b.key === 'freight') assert.equal(b.costCents, null)
    else assert.equal(Number.isInteger(b.costCents), true)
  }
})
