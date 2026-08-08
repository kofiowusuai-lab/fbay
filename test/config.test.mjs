import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, mergeConfig, validateConfig, requireEnv } from '../src/config.mjs'

test('mergeConfig deep-merges user config over defaults', () => {
  const merged = mergeConfig({ thresholds: { minRoi: 0.9 } })
  assert.equal(merged.thresholds.minRoi, 0.9)
  assert.equal(merged.thresholds.minSellThrough, DEFAULTS.thresholds.minSellThrough)
  assert.equal(merged.economics.defaultFvfRate, DEFAULTS.economics.defaultFvfRate)
})

test('mergeConfig does not mutate DEFAULTS', () => {
  mergeConfig({ thresholds: { minRoi: 0.9 } })
  assert.equal(DEFAULTS.thresholds.minRoi, 0.5)
})

test('validateConfig rejects out-of-range rates', () => {
  const r = validateConfig(mergeConfig({ economics: { defaultFvfRate: 1.5 } }))
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /defaultFvfRate/)
})

test('validateConfig accepts the default config', () => {
  assert.equal(validateConfig(mergeConfig({})).ok, true)
})

test('requireEnv reports every missing key at once', () => {
  const r = requireEnv({ FOO: 'x' }, ['FOO', 'BAR', 'BAZ'])
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['BAR', 'BAZ'])
})
