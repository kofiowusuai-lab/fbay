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
  // Order is deliberately randomised, so compare the SET, not the sequence.
  const names = dueWatches(watches, now).map((w) => w.name).sort()
  assert.deepEqual(names, ['a', 'd'])
})

test('dueWatches shuffles order so the traffic pattern is not periodic', () => {
  const now = 1e9
  const watches = Array.from({ length: 8 }, (_, i) => ({ name: String(i), enabled: 1, interval_minutes: 1, last_run_at: 0 }))
  // A constant rng cannot shuffle: every sort key is equal and the sort is
  // stable. Feed a varying sequence, which is what Math.random actually does.
  const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length] }
  const a = dueWatches(watches, now, seq([0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4])).map((w) => w.name).join()
  const b = dueWatches(watches, now, seq([0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6])).map((w) => w.name).join()
  assert.notEqual(a, b)
  assert.deepEqual(a.split(',').sort(), ['0', '1', '2', '3', '4', '5', '6', '7'], 'shuffling must not lose or duplicate a watch')
})

test('jitter stays within the requested fraction', () => {
  for (const r of [0, 0.5, 1]) {
    const j = jitterMs(60000, 0.25, () => r)
    assert.ok(j >= 45000 && j <= 75000)
  }
})
