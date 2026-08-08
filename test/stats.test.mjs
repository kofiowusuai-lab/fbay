import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, excludeReasonFor, filterComps, median, percentile, iqrTrim, buildCompSet } from '../src/comps/stats.mjs'

const DAY = 86400000

test('tokenize lowercases, strips punctuation and drops empties', () => {
  assert.deepEqual(tokenize('Apple iPhone-13 (128GB), Unlocked!'), ['apple', 'iphone', '13', '128gb', 'unlocked'])
})

test('excludeReasonFor catches lots, bundles and parts-only', () => {
  assert.equal(excludeReasonFor('Lot of 5 iPhone 13'), 'bundle')
  assert.equal(excludeReasonFor('iPhone 13 bundle with case'), 'bundle')
  assert.equal(excludeReasonFor('iPhone 13 FOR PARTS ONLY'), 'parts')
  assert.equal(excludeReasonFor('iPhone 13 read description damaged'), 'damaged')
  assert.equal(excludeReasonFor('Apple iPhone 13 128GB Unlocked'), null)
})

test('filterComps excludes comps missing a must token', () => {
  const comps = [
    { title: 'Apple iPhone 13 128GB', priceCents: 30000 },
    { title: 'Apple iPhone 12 128GB', priceCents: 22000 },
  ]
  const out = filterComps(comps, { mustTokens: ['iphone', '13'] })
  assert.equal(out[0].included, true)
  assert.equal(out[1].included, false)
  assert.equal(out[1].excludeReason, 'missing_token:13')
})

test('median handles odd and even lengths', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([]), null)
})

test('percentile uses linear interpolation', () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25)
  assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5)
})

test('iqrTrim removes values outside the 1.5x fence', () => {
  const vals = [100, 102, 104, 106, 108, 110, 5000]
  const r = iqrTrim(vals)
  assert.ok(!r.kept.includes(5000))
  assert.equal(r.kept.length, 6)
})

test('iqrTrim keeps everything when the sample is too small to fence', () => {
  const r = iqrTrim([100, 5000])
  assert.equal(r.kept.length, 2)
})

test('buildCompSet computes trimmed median, sell-through and velocity', () => {
  const now = 100 * DAY
  const sold = [
    { title: 'iPhone 13 128GB', priceCents: 30000, soldAt: now - 7 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 31000, soldAt: now - 14 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 29000, soldAt: now - 21 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 30500, soldAt: now - 28 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 29500, soldAt: now - 35 * DAY },
    { title: 'iPhone 13 128GB', priceCents: 300000, soldAt: now - 40 * DAY },
    { title: 'Lot of 3 iPhone 13', priceCents: 80000, soldAt: now - 10 * DAY },
  ]
  const cs = buildCompSet({ soldComps: sold, activeCount: 100, mustTokens: ['iphone', '13'], now })
  assert.equal(cs.rawN, 7)
  assert.equal(cs.sampleN, 5)              // bundle excluded, 300000 outlier trimmed
  assert.equal(cs.trimmedMedianCents, 30000)
  assert.equal(cs.soldCount, 5)
  assert.ok(Math.abs(cs.sellThrough - 5 / 105) < 1e-9)
  assert.ok(cs.soldPerWeek > 0)
  assert.ok(cs.confidence > 0 && cs.confidence <= 1)
})

test('buildCompSet reports low confidence below the sample floor', () => {
  const now = 100 * DAY
  const cs = buildCompSet({
    soldComps: [{ title: 'iPhone 13', priceCents: 30000, soldAt: now - DAY }],
    activeCount: 10,
    mustTokens: ['iphone'],
    now,
    minSampleSize: 5,
  })
  assert.equal(cs.sampleN, 1)
  assert.equal(cs.lowConfidence, true)
  assert.ok(cs.confidence < 0.4)
})

test('buildCompSet with zero usable comps returns a null median, not a crash', () => {
  const cs = buildCompSet({ soldComps: [], activeCount: 0, mustTokens: ['x'], now: 1 })
  assert.equal(cs.trimmedMedianCents, null)
  assert.equal(cs.sampleN, 0)
  assert.equal(cs.confidence, 0)
  assert.equal(cs.sellThrough, 0)
})

test('an unavailable active count yields null sell-through, NOT 100%', () => {
  // Regression: activeCount defaulting to 0 made sellThrough = sold/sold = 1.0,
  // which passes the 30% floor on every item. Unknown must stay unknown.
  const now = 100 * DAY
  const sold = Array.from({ length: 8 }, (_, i) => ({
    title: 'Apple iPhone 13 128GB', priceCents: 30000 + i * 100, soldAt: now - i * DAY,
  }))
  const cs = buildCompSet({ soldComps: sold, activeCount: 0, activeCountAvailable: false, mustTokens: ['iphone'], now })
  assert.equal(cs.sellThrough, null)
  assert.notEqual(cs.sellThrough, 1)
  assert.equal(cs.activeCountAvailable, false)
  assert.equal(cs.daysOfSupply, null, 'days of supply is meaningless without an active count')
})

test('an available active count of genuinely zero is still 100%, not null', () => {
  const now = 100 * DAY
  const sold = [{ title: 'iPhone 13', priceCents: 30000, soldAt: now - DAY }]
  const cs = buildCompSet({ soldComps: sold, activeCount: 0, activeCountAvailable: true, mustTokens: ['iphone'], now })
  assert.equal(cs.sellThrough, 1, 'zero competition is a real signal, distinct from an unknown')
})
