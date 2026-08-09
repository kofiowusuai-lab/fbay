import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuietHour, dueWatches, jitterMs, runLoop, msUntilQuietEnds } from '../src/watch/schedule.mjs'

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

test('watches run concurrently up to the configured limit', async () => {
  let inFlight = 0
  let peak = 0
  const repo = {
    listWatches: () => Array.from({ length: 6 }, (_, i) => ({ name: `w${i}`, enabled: 1, interval_minutes: 1, last_run_at: null })),
  }
  let ticks = 0
  await runLoop({
    repo,
    config: { quietHours: { start: 0, end: 0 } },
    notifier: { notifyAlert: async () => {} },
    watchConcurrency: 3,
    clock: () => 1e9,
    sleepImpl: async () => {},
    shouldContinue: () => ticks++ < 1,
    logger: { log: () => {} },
    runOne: async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return { ok: true, listingsSeen: 1, listingsNew: 1, dealsFound: 0 }
    },
  })
  assert.equal(peak, 3, `expected 3 concurrent watches, peaked at ${peak}`)
})

test('a blocked scan alerts once, not once per concurrent watch', async () => {
  const alerts = []
  const repo = { listWatches: () => Array.from({ length: 4 }, (_, i) => ({ name: `w${i}`, enabled: 1, interval_minutes: 1, last_run_at: null })) }
  let ticks = 0
  await runLoop({
    repo,
    config: { quietHours: { start: 0, end: 0 } },
    notifier: { notifyAlert: async (m) => alerts.push(m) },
    watchConcurrency: 4,
    clock: () => 1e9,
    sleepImpl: async () => {},
    shouldContinue: () => ticks++ < 1,
    logger: { log: () => {} },
    runOne: async () => ({ ok: false, kind: 'checkpoint', error: 'facebook blocked us' }),
  })
  assert.equal(alerts.length, 1, 'a block is account-level; alerting four times is noise')
})

test('one throwing watch does not stop the others', async () => {
  const done = []
  const repo = { listWatches: () => [1, 2, 3].map((i) => ({ name: `w${i}`, enabled: 1, interval_minutes: 1, last_run_at: null })) }
  let ticks = 0
  await runLoop({
    repo,
    config: { quietHours: { start: 0, end: 0 } },
    notifier: { notifyAlert: async () => {} },
    watchConcurrency: 3,
    clock: () => 1e9,
    sleepImpl: async () => {},
    shouldContinue: () => ticks++ < 1,
    logger: { log: () => {} },
    runOne: async (w) => {
      if (w.name === 'w2') throw new Error('boom')
      done.push(w.name)
      return { ok: true, listingsSeen: 0, listingsNew: 0, dealsFound: 0 }
    },
  })
  assert.deepEqual(done.sort(), ['w1', 'w3'])
})

test('msUntilQuietEnds targets the next occurrence of the wake hour', () => {
  const at = (h) => new Date(2026, 7, 9, h, 0, 0).getTime()
  const q = { start: 23, end: 7 }
  assert.equal(Math.round(msUntilQuietEnds(at(2), q) / 3600000), 5, '02:00 is five hours from 07:00')
  assert.equal(Math.round(msUntilQuietEnds(at(23), q) / 3600000), 8, '23:00 wakes at 07:00 tomorrow')
})

test('quiet hours are announced once, not once per poll', async () => {
  const lines = []
  let ticks = 0
  await runLoop({
    repo: { listWatches: () => [] },
    config: { quietHours: { start: 0, end: 23 } },
    notifier: { notifyAlert: async () => {} },
    clock: () => new Date(2026, 7, 9, 2, 0, 0).getTime(),
    sleepImpl: async () => {},
    shouldContinue: () => ticks++ < 5,
    logger: { log: (m) => lines.push(m) },
    runOne: async () => ({ ok: true }),
  })
  const quiet = lines.filter((l) => /quiet hours/.test(l))
  assert.equal(quiet.length, 1, `announced ${quiet.length} times; the log should not fill with duplicates`)
  assert.match(quiet[0], /sleeping/)
})
