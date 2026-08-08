import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapPool } from '../src/watch/pool.mjs'

test('every item is processed exactly once, in order of result', async () => {
  const r = await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 10)
  assert.deepEqual(r.map((x) => x.value), [10, 20, 30, 40, 50])
})

test('concurrency never exceeds the limit', async () => {
  let inFlight = 0
  let peak = 0
  await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    peak = Math.max(peak, ++inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
  })
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`)
  assert.equal(peak, 3, 'and it should actually reach the limit')
})

test('one failure does not strand the rest', async () => {
  const r = await mapPool([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom')
    return n
  })
  assert.equal(r[0].ok, true)
  assert.equal(r[1].ok, false)
  assert.match(r[1].error.message, /boom/)
  assert.equal(r[2].ok, true, 'the third item still ran')
})

test('it is genuinely faster than sequential', async () => {
  const t0 = Date.now()
  await mapPool(Array.from({ length: 8 }, (_, i) => i), 4, async () => new Promise((r) => setTimeout(r, 50)))
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 8 * 50 * 0.7, `took ${elapsed}ms, expected well under the 400ms sequential cost`)
})

test('an empty list is a no-op', async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), [])
})
