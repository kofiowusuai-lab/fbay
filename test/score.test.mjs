import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters } from '../src/score/filters.mjs'
import { scoreDeal, saturate } from '../src/score/rank.mjs'
import { DEFAULTS } from '../src/config.mjs'

const good = {
  listing: { title: 'Apple iPhone 13 128GB unlocked', priceCents: 12000, sellerName: 'Jane', listedAt: Date.now() - 3600000 },
  identity: { identityConfidence: 0.9, category: 'phone' },
  compset: { sellThrough: 0.55, sampleN: 12, confidence: 0.8 },
  profit: { netCents: 11945, roi: 0.99, breakevenBuyCents: 23945, freight: false },
}

test('a good deal passes every filter', () => {
  const r = applyFilters(good, DEFAULTS)
  assert.equal(r.passed, true)
  assert.deepEqual(r.rejections, [])
})

test('low net profit is rejected with a named reason', () => {
  const r = applyFilters({ ...good, profit: { ...good.profit, netCents: 500 } }, DEFAULTS)
  assert.equal(r.passed, false)
  assert.equal(r.rejections[0].rule, 'min_net_profit')
  assert.match(r.rejections[0].reason, /\$5\.00/)
})

test('low sell-through is rejected', () => {
  const r = applyFilters({ ...good, compset: { ...good.compset, sellThrough: 0.1 } }, DEFAULTS)
  assert.equal(r.rejections[0].rule, 'min_sell_through')
})

test('every failing rule is reported, not just the first', () => {
  const bad = {
    ...good,
    profit: { ...good.profit, netCents: 100, roi: 0.01 },
    compset: { sellThrough: 0.05, sampleN: 1, confidence: 0.1 },
    identity: { identityConfidence: 0.2, category: 'phone' },
  }
  const r = applyFilters(bad, DEFAULTS)
  const rules = r.rejections.map((x) => x.rule).sort()
  assert.deepEqual(rules, ['min_comp_sample', 'min_identity_confidence', 'min_net_profit', 'min_roi', 'min_sell_through'])
})

test('freight is rejected when freight is disabled', () => {
  const r = applyFilters({ ...good, profit: { ...good.profit, freight: true, netCents: null } }, DEFAULTS)
  assert.ok(r.rejections.some((x) => x.rule === 'freight_disabled'))
})

test('freight passes when freight is enabled', () => {
  const cfg = { ...DEFAULTS, freight: { enabled: true } }
  const r = applyFilters({ ...good, profit: { ...good.profit, freight: true } }, cfg)
  assert.ok(!r.rejections.some((x) => x.rule === 'freight_disabled'))
})

test('a blacklisted keyword in the title is rejected', () => {
  const r = applyFilters({ ...good, listing: { ...good.listing, title: 'iPhone 13 for parts' } }, DEFAULTS)
  assert.equal(r.rejections[0].rule, 'blacklist_keyword')
})

test('a blacklisted seller is rejected', () => {
  const cfg = { ...DEFAULTS, blacklist: { ...DEFAULTS.blacklist, sellers: ['Jane'] } }
  const r = applyFilters(good, cfg)
  assert.ok(r.rejections.some((x) => x.rule === 'blacklist_seller'))
})

test('saturate is monotonic and bounded in 0..1', () => {
  assert.equal(saturate(0, 100), 0)
  assert.ok(saturate(100, 100) === 0.5)
  assert.ok(saturate(1e9, 100) < 1)
  assert.ok(saturate(50, 100) < saturate(150, 100))
})

test('scoreDeal is bounded and rewards profit', () => {
  const s1 = scoreDeal(good, DEFAULTS)
  const s2 = scoreDeal({ ...good, profit: { ...good.profit, netCents: 50000 } }, DEFAULTS)
  assert.ok(s1 >= 0 && s1 <= 1)
  assert.ok(s2 > s1)
})

test('a price drop increases the score', () => {
  const dropped = { ...good, priceDrop: { previousPriceCents: 20000, currentPriceCents: 12000 } }
  assert.ok(scoreDeal(dropped, DEFAULTS) > scoreDeal(good, DEFAULTS))
})

test('an older listing scores lower than a fresh one', () => {
  const old = { ...good, listing: { ...good.listing, listedAt: Date.now() - 14 * 86400000 } }
  assert.ok(scoreDeal(old, DEFAULTS) < scoreDeal(good, DEFAULTS))
})
