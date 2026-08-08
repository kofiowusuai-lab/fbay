import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/db.mjs'
import { createRepo } from '../src/db/repo.mjs'
import { contentHash, identityKeyFor } from '../src/identify/cache.mjs'
import { identify, IDENTITY_SCHEMA, buildUserPrompt, normaliseIdentity, CATEGORIES, CONDITIONS } from '../src/identify/extract.mjs'
import { DEFAULTS } from '../src/config.mjs'

const listing = { fbId: '1', title: 'MacBook good condition', description: '13 inch 2019 256gb', priceCents: 40000, imageUrls: ['https://x/a.jpg'] }

const RAW = {
  brand: 'Apple', model: 'MacBook Air', variant: '13-inch', capacity: '256GB',
  modelYear: 2019, category: 'laptop', condition: 'good', identityConfidence: 0.82,
  query: 'apple macbook air 13 2019 256gb', mustTokens: ['macbook', 'air', '2019'], weightLb: 5,
}

function fakeLlm (data, { onCall } = {}) {
  return {
    extractStructured: async (req) => {
      onCall?.(req)
      return { ok: true, data, usage: {}, model: 'test-model' }
    },
  }
}

test('contentHash is stable and changes with content', () => {
  assert.equal(contentHash(listing), contentHash({ ...listing }))
  assert.notEqual(contentHash(listing), contentHash({ ...listing, title: 'other' }))
})

test('identityKeyFor ignores irrelevant fields and normalises case', () => {
  const a = identityKeyFor({ brand: 'Apple', model: 'MacBook Air', variant: '13-inch', capacity: '256GB', category: 'laptop', condition: 'good' })
  const b = identityKeyFor({ brand: 'apple', model: 'macbook air', variant: '13-INCH', capacity: '256gb', category: 'laptop', condition: 'good', modelYear: 2019 })
  assert.equal(a, b)
})

test('identityKeyFor separates different conditions', () => {
  const good = identityKeyFor({ brand: 'a', model: 'b', category: 'laptop', condition: 'good' })
  const parts = identityKeyFor({ brand: 'a', model: 'b', category: 'laptop', condition: 'for_parts' })
  assert.notEqual(good, parts)
})

test('IDENTITY_SCHEMA constrains category and condition to known enums', () => {
  assert.deepEqual(IDENTITY_SCHEMA.properties.category.enum, CATEGORIES)
  assert.deepEqual(IDENTITY_SCHEMA.properties.condition.enum, CONDITIONS)
})

test('buildUserPrompt includes the title, description and ask price', () => {
  const p = buildUserPrompt(listing)
  assert.match(p, /MacBook good condition/)
  assert.match(p, /13 inch 2019 256gb/)
  assert.match(p, /\$400/)
})

test('normaliseIdentity lowercases must tokens and clamps confidence', () => {
  const n = normaliseIdentity({ ...RAW, mustTokens: ['MacBook', 'AIR'], identityConfidence: 1.7 })
  assert.deepEqual(n.mustTokens, ['macbook', 'air'])
  assert.equal(n.identityConfidence, 1)
})

test('normaliseIdentity falls back to a safe category and condition', () => {
  const n = normaliseIdentity({ ...RAW, category: 'not_a_category', condition: 'weird' })
  assert.equal(n.category, 'other')
  assert.equal(n.condition, 'good')
})

test('identify calls the model and persists the result', async () => {
  const repo = createRepo(openDb(':memory:'))
  const r = await identify({ listing, repo, llm: fakeLlm(RAW), config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(r.ok, true)
  assert.equal(r.cached, false)
  assert.equal(r.identity.brand, 'Apple')
  assert.ok(r.identity.identityKey)
  assert.ok(repo.getIdentityByContentHash(contentHash(listing)))
})

test('a second identify for the same content is served from cache with no model call', async () => {
  const repo = createRepo(openDb(':memory:'))
  let calls = 0
  const llm = { extractStructured: async () => { calls++; return { ok: true, data: RAW, usage: {}, model: 'm' } } }
  await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  const second = await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(calls, 1)
  assert.equal(second.cached, true)
  assert.equal(second.identity.model, 'MacBook Air')
})

test('low confidence escalates to the smart model exactly once', async () => {
  const repo = createRepo(openDb(':memory:'))
  const models = []
  const llm = {
    extractStructured: async (req) => {
      models.push(req.model)
      return { ok: true, data: { ...RAW, identityConfidence: models.length === 1 ? 0.3 : 0.88 }, usage: {}, model: req.model }
    },
  }
  const r = await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(models.length, 2)
  assert.notEqual(models[0], models[1])
  assert.equal(r.identity.identityConfidence, 0.88)
  assert.equal(r.escalated, true)
})

test('images are fetched and passed to the model when available', async () => {
  const repo = createRepo(openDb(':memory:'))
  let seenImages = null
  const llm = fakeLlm(RAW, { onCall: (req) => { seenImages = req.images } })
  await identify({
    listing, repo, llm, config: DEFAULTS,
    imageFetcher: async () => ({ mediaType: 'image/jpeg', base64: 'AAA' }),
  })
  assert.equal(seenImages.length, 1)
  assert.equal(seenImages[0].mediaType, 'image/jpeg')
})

test('a model failure returns ok:false and persists nothing', async () => {
  const repo = createRepo(openDb(':memory:'))
  const llm = { extractStructured: async () => ({ ok: false, error: 'overloaded' }) }
  const r = await identify({ listing, repo, llm, config: DEFAULTS, imageFetcher: async () => null })
  assert.equal(r.ok, false)
  assert.match(r.error, /overloaded/)
  assert.equal(repo.getIdentityByContentHash(contentHash(listing)), undefined)
})
