import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters, prefilter, isNearMiss } from '../src/score/filters.mjs'

const applyPre = (listing) => prefilter(listing, DEFAULTS)
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

test('a null sell-through is rejected, never silently passed', () => {
  const r = applyFilters({ ...good, compset: { ...good.compset, sellThrough: null } }, DEFAULTS)
  assert.equal(r.passed, false)
  assert.ok(r.rejections.some((x) => x.rule === 'sell_through_unavailable'))
  assert.match(r.rejections.find((x) => x.rule === 'sell_through_unavailable').reason, /unknown as a pass/)
})

test('a null sell-through scores zero velocity, not full marks', () => {
  const known = scoreDeal(good, DEFAULTS)
  const unknown = scoreDeal({ ...good, compset: { ...good.compset, sellThrough: null } }, DEFAULTS)
  assert.ok(unknown < known, 'an unknown must never outscore a measured good value')
})

test('prefilter rejects blacklisted titles with no model call', () => {
  const r = applyPre({ title: 'AirPods Pro 1 (BOX ONLY)', priceCents: 500 })
  assert.equal(r.rejected, true)
  assert.equal(r.rule, 'blacklist_keyword')
})

test('prefilter rejects an ask above the ceiling', () => {
  const r = applyPre({ title: 'Clean iPhone', priceCents: 999999 })
  assert.equal(r.rejected, true)
  assert.equal(r.rule, 'max_ask')
})

test('prefilter passes a plausible listing through', () => {
  assert.equal(applyPre({ title: 'DeWalt DCD791 drill', priceCents: 6000 }).rejected, false)
})

const T = DEFAULTS.thresholds
const nearCfg = { minNetProfitCents: 2000, thresholds: T }

test('a near miss must be close to the floor, not merely one rule short', () => {
  // Sell-through 30% against a 35% floor is genuinely close.
  const close = { rejections: [{ rule: 'min_sell_through' }], profit: { netCents: 4000 }, compset: { sellThrough: 0.30 } }
  assert.equal(isNearMiss(close, nearCfg), true)
})

test('a catastrophic miss is not a near miss', () => {
  // The real case: a Nintendo Switch at 6% sell-through against a 35% floor,
  // 665 listed against 43 sold, was being sent as a "near miss".
  const far = { rejections: [{ rule: 'min_sell_through' }], profit: { netCents: 4556 }, compset: { sellThrough: 0.06 } }
  assert.equal(isNearMiss(far, nearCfg), false)
})

test('roi and net profit are measured against their own floors', () => {
  const roiClose = { rejections: [{ rule: 'min_roi' }], profit: { netCents: 4000, roi: T.minRoi * 0.8 } }
  const roiFar = { rejections: [{ rule: 'min_roi' }], profit: { netCents: 4000, roi: T.minRoi * 0.2 } }
  assert.equal(isNearMiss(roiClose, nearCfg), true)
  assert.equal(isNearMiss(roiFar, nearCfg), false)
})

test('an unknown sell-through is not near anything', () => {
  const unknown = { rejections: [{ rule: 'sell_through_unavailable' }], profit: { netCents: 9000 } }
  assert.equal(isNearMiss(unknown, nearCfg), false)
})

test('two failed rules is not a near miss', () => {
  const ev = { rejections: [{ rule: 'min_roi' }, { rule: 'min_sell_through' }], profit: { netCents: 4000 }, compset: { sellThrough: 0.34 } }
  assert.equal(isNearMiss(ev, nearCfg), false)
})

test('a loss is never a near miss however close the other numbers', () => {
  const ev = { rejections: [{ rule: 'min_sell_through' }], profit: { netCents: -500 }, compset: { sellThrough: 0.34 } }
  assert.equal(isNearMiss(ev, nearCfg), false)
})

test('a hard no is never softened into a near miss', () => {
  for (const rule of ['blacklist_keyword', 'max_ask', 'freight_disabled', 'foreign_listing']) {
    const ev = { rejections: [{ rule }], profit: { netCents: 9000 }, compset: { sellThrough: 0.9 } }
    assert.equal(isNearMiss(ev, nearCfg), false, rule)
  }
})
