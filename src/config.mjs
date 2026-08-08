import fs from 'node:fs'
import path from 'node:path'

export const DEFAULTS = {
  marketplace: 'EBAY_US',
  currency: 'USD',
  compsTtlHours: 168,
  thresholds: {
    minNetProfitCents: 3000,
    minRoi: 0.5,
    minSellThrough: 0.30,
    minIdentityConfidence: 0.6,
    minCompSampleSize: 5,
    maxAskCents: 200000,
  },
  economics: {
    defaultFvfRate: 0.1325,
    promotedRate: 0,
    bufferRate: 0.05,
  },
  weights: {
    profit: 0.35,
    roi: 0.25,
    velocity: 0.20,
    confidence: 0.15,
    age: 0.05,
    drop: 0.10,
  },
  freight: { enabled: false },
  pace: {
    maxListingsPerDay: 600,
    maxRequestsPerHour: 120,
    minDelayMs: 1800,
    maxDelayMs: 6500,
    detailFetchRatio: 0.35,
  },
  quietHours: { start: 23, end: 7 },
  blacklist: { keywords: ['broken', 'as is', 'for parts', 'no returns', 'scam'], sellers: [] },
}

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function mergeConfig (user = {}, base = DEFAULTS) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(user)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeConfig(v, base[k]) : v
  }
  return out
}

const RATE_KEYS = [
  ['economics.defaultFvfRate', 0, 1],
  ['economics.promotedRate', 0, 1],
  ['economics.bufferRate', 0, 1],
  ['thresholds.minSellThrough', 0, 1],
  ['thresholds.minIdentityConfidence', 0, 1],
]

function get (obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
}

export function validateConfig (config) {
  const errors = []
  for (const [key, min, max] of RATE_KEYS) {
    const v = get(config, key)
    if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max) {
      errors.push(`${key} must be a number between ${min} and ${max}, got ${v}`)
    }
  }
  if (config.thresholds.minCompSampleSize < 1) {
    errors.push('thresholds.minCompSampleSize must be at least 1')
  }
  if (config.pace.minDelayMs > config.pace.maxDelayMs) {
    errors.push('pace.minDelayMs must not exceed pace.maxDelayMs')
  }
  return { ok: errors.length === 0, errors }
}

export function requireEnv (env, keys) {
  const missing = keys.filter((k) => !env[k])
  return { ok: missing.length === 0, missing }
}

export function loadConfig (configPath = path.join(process.cwd(), 'config.json')) {
  let user = {}
  if (fs.existsSync(configPath)) {
    user = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  }
  const config = mergeConfig(user)
  const v = validateConfig(config)
  if (!v.ok) {
    throw new Error(`Invalid config at ${configPath}:\n  ${v.errors.join('\n  ')}`)
  }
  return config
}
