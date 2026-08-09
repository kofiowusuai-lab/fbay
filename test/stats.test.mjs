import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarise, accuracy } from '../src/stats.mjs'

const DAY = 86400000

test('summarise reports realised profit and return on capital', () => {
  const s = summarise([
    { bought_cents: 5000, sold_cents: 12000, postage_cents: 450, fees_cents: 0, bought_at: 0, sold_at: 7 * DAY },
    { bought_cents: 3000, sold_cents: 7000, postage_cents: 320, fees_cents: 0, bought_at: 0, sold_at: 14 * DAY },
  ])
  assert.equal(s.flips, 2)
  assert.equal(s.totalNetCents, (12000 - 5000 - 450) + (7000 - 3000 - 320))
  assert.equal(s.capitalDeployedCents, 8000)
  assert.ok(s.returnOnCapital > 1)
  assert.equal(s.avgDaysToSell, 10.5)
})

test('unsold items are counted as open, not as profit', () => {
  const s = summarise([
    { bought_cents: 5000, sold_cents: 12000, postage_cents: 0, fees_cents: 0, bought_at: 0, sold_at: DAY },
    { bought_cents: 4000, sold_cents: null, bought_at: 0, sold_at: null },
  ])
  assert.equal(s.flips, 1)
  assert.equal(s.open, 1, 'capital still tied up must not read as a win')
  assert.equal(s.totalNetCents, 7000)
})

test('throughput is reported per week, which is what a subscriber buys', () => {
  const now = 28 * DAY
  const s = summarise(
    Array.from({ length: 8 }, () => ({ bought_cents: 5000, sold_cents: 9000, postage_cents: 0, fees_cents: 0, bought_at: 0, sold_at: DAY })),
    { firstAlertAt: 0, now }
  )
  assert.equal(s.flipsPerWeek, 2)
  assert.equal(s.weeklyNetCents, 8000)
})

test('accuracy flags over-prediction as the dangerous direction', () => {
  const a = accuracy([
    { net_profit_cents: 4000, bought_cents: 5000, sold_cents: 8000, postage_cents: 0, fees_cents: 0 },
    { net_profit_cents: 3000, bought_cents: 4000, sold_cents: 6500, postage_cents: 0, fees_cents: 0 },
  ])
  assert.equal(a.n, 2)
  assert.ok(a.meanErrorCents < 0)
  assert.equal(a.bias, 'over-predicts profit')
  assert.equal(a.optimisticCount, 2)
})

test('accuracy on no data says so rather than inventing a number', () => {
  assert.equal(accuracy([]).n, 0)
})
