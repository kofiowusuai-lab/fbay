import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuietHour, dueWatches, jitterMs } from '../src/watch/schedule.mjs'

test('quiet hours wrapping midnight are handled', () => {
  const q = { start: 23, end: 7 }
  assert.equal(isQuietHour(23, q), true)
  assert.equal(isQuietHour(2, q), true)
  assert.equal(isQuietHour(7, q), false)
  assert.equal(isQuietHour(12, q), false)
})

test('non-wrapping quiet hours are handled', () => {
  const q = { start: 1, end: 5 }
  assert.equal(isQuietHour(3, q), true)
  assert.equal(isQuietHour(23, q), false)
})

test('quiet hours are disabled when start equals end', () => {
  assert.equal(isQuietHour(3, { start: 0, end: 0 }), false)
})

test('dueWatches returns only enabled watches past their interval', () => {
  const now = 1000 * 60 * 60
  const watches = [
    { name: 'a', enabled: 1, interval_minutes: 30, last_run_at: now - 31 * 60000 },
    { name: 'b', enabled: 1, interval_minutes: 30, last_run_at: now - 5 * 60000 },
    { name: 'c', enabled: 0, interval_minutes: 1, last_run_at: 0 },
    { name: 'd', enabled: 1, interval_minutes: 60, last_run_at: null },
  ]
  assert.deepEqual(dueWatches(watches, now).map((w) => w.name), ['a', 'd'])
})

test('dueWatches shuffles order so the traffic pattern is not periodic', () => {
  const now = 1e9
  const watches = Array.from({ length: 8 }, (_, i) => ({ name: String(i), enabled: 1, interval_minutes: 1, last_run_at: 0 }))
  const a = dueWatches(watches, now, () => 0.9).map((w) => w.name).join()
  const b = dueWatches(watches, now, () => 0.1).map((w) => w.name).join()
  assert.notEqual(a, b)
})

test('jitter stays within the requested fraction', () => {
  for (const r of [0, 0.5, 1]) {
    const j = jitterMs(60000, 0.25, () => r)
    assert.ok(j >= 45000 && j <= 75000)
  }
})
