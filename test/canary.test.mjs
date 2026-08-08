import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'
import { CANARIES, runCanary, runAllCanaries, scanningShouldHalt } from '../src/watch/canary.mjs'

const CANARY = CANARIES[0]

function soldWith (comps, strategy = 's-card') {
  return { fetchSold: async () => ({ ok: true, strategy, comps }) }
}

const OK_COMPS = Array.from({ length: 25 }, (_, i) => ({ title: 'Apple iPhone 13 128GB Unlocked', priceCents: 25000 + i * 100, soldAt: 1 }))

test('a healthy canary passes and resets the failure count', async () => {
  const repo = createRepo(openDb(':memory:'))
  repo.recordCanary(CANARY.name, false, 1)
  const r = await runCanary({ canary: CANARY, sold: soldWith(OK_COMPS), repo, now: 100 })
  assert.equal(r.ok, true)
  assert.equal(repo.getCanary(CANARY.name).consecutive_failures, 0)
})

test('zero results fails the canary with a drift reason', async () => {
  const repo = createRepo(openDb(':memory:'))
  const r = await runCanary({ canary: CANARY, sold: soldWith([], null), repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no selector strategy|zero results/i)
  assert.equal(repo.getCanary(CANARY.name).consecutive_failures, 1)
})

test('too few results fails the canary', async () => {
  const repo = createRepo(openDb(':memory:'))
  const r = await runCanary({ canary: CANARY, sold: soldWith(OK_COMPS.slice(0, 2)), repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /only 2/)
})

test('a median outside the sanity band fails the canary', async () => {
  const repo = createRepo(openDb(':memory:'))
  const absurd = OK_COMPS.map((c) => ({ ...c, priceCents: 5 }))
  const r = await runCanary({ canary: CANARY, sold: soldWith(absurd), repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /median/i)
})

test('a fetch error fails the canary without throwing', async () => {
  const repo = createRepo(openDb(':memory:'))
  const sold = { fetchSold: async () => ({ ok: false, error: 'ebay 503' }) }
  const r = await runCanary({ canary: CANARY, sold, repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /503/)
})

test('two consecutive failures halt scanning', () => {
  const repo = createRepo(openDb(':memory:'))
  repo.recordCanary(CANARY.name, false, 1)
  assert.equal(scanningShouldHalt(repo), false)
  repo.recordCanary(CANARY.name, false, 2)
  assert.equal(scanningShouldHalt(repo), true)
})

test('runAllCanaries alerts once with a combined message', async () => {
  const repo = createRepo(openDb(':memory:'))
  const alerts = []
  const r = await runAllCanaries({ sold: soldWith([], null), repo, notifier: { notifyAlert: async (m) => alerts.push(m) }, now: 1 })
  assert.equal(r.ok, false)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /canary/i)
})

test('a throwing sold client fails the canary instead of killing the run', async () => {
  // Canaries run at monitor startup, so an exception here killed the monitor
  // before it scanned anything at all.
  const repo = createRepo(openDb(':memory:'))
  const sold = { fetchSold: async () => { throw new Error('page.goto: Timeout 60000ms exceeded') } }
  const r = await runCanary({ canary: CANARY, sold, repo, now: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /threw/)
  assert.match(r.reason, /Timeout/)
  assert.equal(repo.getCanary(CANARY.name).consecutive_failures, 1)
})
