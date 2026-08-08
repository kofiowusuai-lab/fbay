import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeProfit } from '../src/economics/profit.mjs'
import { DEFAULTS } from '../src/config.mjs'

const cfg = DEFAULTS

// Worked example, computed by hand:
// gross 30000, category phone (0.1325 fvf), ask 12000
// fvf       = 30000 * 0.1325 = 3975
// perOrder  = 30
// shipping  = phone -> 1lb -> letter band -> 550
// promoted  = 0
// buffer    = 30000 * 0.05 = 1500
// breakeven = 30000 - 3975 - 30 - 550 - 0 - 1500 = 23945
// net       = 23945 - 12000 = 11945
// roi       = 11945 / 12000 = 0.99541666...
// margin    = 11945 / 30000 = 0.398166...
test('worked example produces exact expected line items', () => {
  const p = computeProfit({ grossCents: 30000, askCents: 12000, category: 'phone', config: cfg })
  assert.equal(p.fvfCents, 3975)
  assert.equal(p.perOrderCents, 30)
  assert.equal(p.shippingCents, 550)
  assert.equal(p.promotedCents, 0)
  assert.equal(p.bufferCents, 1500)
  assert.equal(p.breakevenBuyCents, 23945)
  assert.equal(p.netCents, 11945)
  assert.ok(Math.abs(p.roi - 0.9954166666) < 1e-6)
  assert.ok(Math.abs(p.margin - 0.3981666666) < 1e-6)
  assert.equal(p.freight, false)
})

test('net is exactly breakeven minus ask', () => {
  const p = computeProfit({ grossCents: 50000, askCents: 31000, category: 'laptop', config: cfg })
  assert.equal(p.netCents, p.breakevenBuyCents - 31000)
})

test('an overpriced ask yields negative net', () => {
  const p = computeProfit({ grossCents: 10000, askCents: 9500, category: 'phone', config: cfg })
  assert.ok(p.netCents < 0)
  assert.ok(p.roi < 0)
})

test('freight categories are flagged and have null net', () => {
  const p = computeProfit({ grossCents: 40000, askCents: 10000, category: 'furniture', config: cfg })
  assert.equal(p.freight, true)
  assert.equal(p.netCents, null)
  assert.equal(p.breakevenBuyCents, null)
})

test('local resale removes shipping and un-flags freight', () => {
  const p = computeProfit({ grossCents: 40000, askCents: 10000, category: 'furniture', config: cfg, localResale: true })
  assert.equal(p.freight, false)
  assert.equal(p.shippingCents, 0)
  assert.equal(p.breakevenBuyCents, 40000 - 5300 - 30 - 0 - 0 - 2000)
})

test('a free item returns null roi rather than Infinity', () => {
  const p = computeProfit({ grossCents: 10000, askCents: 0, category: 'phone', config: cfg })
  assert.equal(p.roi, null)
  assert.ok(p.netCents > 0)
})

test('sub-$10 gross uses the 40c per-order fee band', () => {
  const p = computeProfit({ grossCents: 900, askCents: 100, category: 'phone', config: cfg })
  assert.equal(p.perOrderCents, 40)
})

test('promoted rate from config is applied', () => {
  const promoted = { ...cfg, economics: { ...cfg.economics, promotedRate: 0.04 } }
  const p = computeProfit({ grossCents: 20000, askCents: 5000, category: 'phone', config: promoted })
  assert.equal(p.promotedCents, 800)
})

test('an explicit weight override changes the shipping band', () => {
  const p = computeProfit({ grossCents: 30000, askCents: 5000, category: 'phone', config: cfg, weightLb: 12 })
  assert.equal(p.shippingCents, 3200)
})
