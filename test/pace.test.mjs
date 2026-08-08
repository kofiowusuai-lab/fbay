import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPacer, PaceLimitError } from '../src/source/facebook/pace.mjs'
import { DEFAULTS } from '../src/config.mjs'

function harness (overrides = {}) {
  let t = 0
  const slept = []
  const pacer = createPacer({
    config: { ...DEFAULTS.pace, ...overrides },
    clock: () => t,
    sleepImpl: async (ms) => { slept.push(ms); t += ms },
    rng: () => 0.5,
  })
  return { pacer, slept, advance: (ms) => { t += ms }, now: () => t }
}

test('delay is drawn inside the configured bounds', () => {
  const { pacer } = harness({ minDelayMs: 1000, maxDelayMs: 3000 })
  for (const r of [0, 0.25, 0.5, 0.99, 1]) {
    const d = pacer.nextDelayMs(r)
    assert.ok(d >= 1000 && d <= 3000, `delay ${d} out of bounds`)
  }
})

test('delay is not a constant across different random draws', () => {
  const { pacer } = harness({ minDelayMs: 1000, maxDelayMs: 5000 })
  assert.notEqual(pacer.nextDelayMs(0.1), pacer.nextDelayMs(0.9))
})

test('beforeRequest sleeps between calls', async () => {
  const { pacer, slept } = harness()
  await pacer.beforeRequest()
  await pacer.beforeRequest()
  assert.equal(slept.length, 1)  // no sleep before the very first request
  assert.ok(slept[0] > 0)
})

test('the hourly request ceiling throws PaceLimitError', async () => {
  const { pacer } = harness({ maxRequestsPerHour: 2, minDelayMs: 1, maxDelayMs: 1 })
  await pacer.beforeRequest()
  await pacer.beforeRequest()
  await assert.rejects(() => pacer.beforeRequest(), PaceLimitError)
})

test('the hourly window rolls forward', async () => {
  const { pacer, advance } = harness({ maxRequestsPerHour: 2, minDelayMs: 1, maxDelayMs: 1 })
  await pacer.beforeRequest()
  await pacer.beforeRequest()
  advance(3600001)
  await pacer.beforeRequest()
  assert.equal(pacer.stats().requestsThisHour, 1)
})

test('the daily listing budget is enforced', () => {
  const { pacer } = harness({ maxListingsPerDay: 5 })
  pacer.countListings(4)
  assert.equal(pacer.listingBudgetRemaining(), 1)
  pacer.countListings(1)
  assert.equal(pacer.listingBudgetRemaining(), 0)
  assert.equal(pacer.listingBudgetExhausted(), true)
})

test('recordBlock sets a cooldown that blocks further requests', async () => {
  const { pacer, advance } = harness({ minDelayMs: 1, maxDelayMs: 1 })
  pacer.recordBlock('checkpoint')
  assert.equal(pacer.isCoolingDown(), true)
  await assert.rejects(() => pacer.beforeRequest(), PaceLimitError)
  advance(pacer.stats().cooldownMs + 1)
  assert.equal(pacer.isCoolingDown(), false)
})

test('consecutive blocks lengthen the cooldown', () => {
  const { pacer } = harness()
  pacer.recordBlock('checkpoint')
  const first = pacer.stats().cooldownMs
  pacer.recordBlock('checkpoint')
  assert.ok(pacer.stats().cooldownMs > first)
})

test('shouldFetchDetail respects the configured ratio deterministically', () => {
  const { pacer } = harness({ detailFetchRatio: 0.35 })
  assert.equal(pacer.shouldFetchDetail(0.2), true)
  assert.equal(pacer.shouldFetchDetail(0.9), false)
})
