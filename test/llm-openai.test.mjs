import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiLlmClient, toStrictSchema, tokenLimitField, buildContent, OPENAI_MODELS } from '../src/llm-openai.mjs'
import { createLlm, detectAuth } from '../src/llm.mjs'
import { IDENTITY_SCHEMA } from '../src/identify/extract.mjs'

function fakeFetch (responses) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) })
    const r = responses.shift()
    return { ok: r.status === undefined ? true : r.status < 400, status: r.status ?? 200,
      json: async () => r.body, text: async () => JSON.stringify(r.body) }
  }
  fn.calls = calls
  return fn
}

const okRes = (obj, model = 'gpt-5-mini') => ({
  body: { model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) } }], usage: { total_tokens: 10 } },
})

test('toStrictSchema makes every property required and forbids extras', () => {
  const s = toStrictSchema(IDENTITY_SCHEMA)
  assert.deepEqual(s.required.sort(), Object.keys(IDENTITY_SCHEMA.properties).sort())
  assert.equal(s.additionalProperties, false)
})

test('toStrictSchema recurses into arrays without corrupting them', () => {
  const s = toStrictSchema(IDENTITY_SCHEMA)
  assert.equal(s.properties.mustTokens.type, 'array')
  assert.equal(s.properties.mustTokens.items.type, 'string')
})

test('the gpt-5 family uses max_completion_tokens, older models use max_tokens', () => {
  assert.equal(tokenLimitField('gpt-5-mini'), 'max_completion_tokens')
  assert.equal(tokenLimitField('gpt-4o'), 'max_tokens')
})

test('images become data URIs ahead of the text block', () => {
  const c = buildContent({ user: 'identify this', images: [{ mediaType: 'image/jpeg', base64: 'AAA' }] })
  assert.equal(c[0].type, 'image_url')
  assert.match(c[0].image_url.url, /^data:image\/jpeg;base64,AAA$/)
  assert.equal(c[1].type, 'text')
})

test('extractStructured returns parsed JSON', async () => {
  const fetchImpl = fakeFetch([okRes({ brand: 'Apple' })])
  const c = createOpenAiLlmClient({ apiKey: 'k', fetchImpl })
  const r = await c.extractStructured({ system: 's', user: 'u', schema: IDENTITY_SCHEMA })
  assert.equal(r.ok, true)
  assert.equal(r.data.brand, 'Apple')
})

test('anthropic model tiers map onto openai tiers', async () => {
  const fetchImpl = fakeFetch([okRes({}), okRes({})])
  const c = createOpenAiLlmClient({ apiKey: 'k', fetchImpl })
  await c.extractStructured({ system: 's', user: 'u', schema: IDENTITY_SCHEMA, model: 'claude-haiku-4-5-20251001' })
  await c.extractStructured({ system: 's', user: 'u', schema: IDENTITY_SCHEMA, model: 'claude-opus-5' })
  assert.equal(fetchImpl.calls[0].body.model, OPENAI_MODELS.fast)
  assert.equal(fetchImpl.calls[1].body.model, OPENAI_MODELS.smart, 'escalation must still reach a stronger model')
})

test('a truncated response is an error, not silently-bad JSON', async () => {
  const fetchImpl = fakeFetch([{ body: { choices: [{ finish_reason: 'length', message: { content: '{"brand":"Ap' } }] } }])
  const c = createOpenAiLlmClient({ apiKey: 'k', fetchImpl, retries: 0 })
  const r = await c.extractStructured({ system: 's', user: 'u', schema: IDENTITY_SCHEMA })
  assert.equal(r.ok, false)
  assert.match(r.error, /truncated/)
})

test('an http error is retried then reported', async () => {
  const fetchImpl = fakeFetch([{ status: 500, body: {} }, okRes({ brand: 'Apple' })])
  const c = createOpenAiLlmClient({ apiKey: 'k', fetchImpl, retries: 2, sleepImpl: async () => {} })
  const r = await c.extractStructured({ system: 's', user: 'u', schema: IDENTITY_SCHEMA })
  assert.equal(r.ok, true)
  assert.equal(fetchImpl.calls.length, 2)
})

test('detectAuth reports openai when only an OpenAI key is present', () => {
  const r = detectAuth({ OPENAI_API_KEY: 'sk-x' })
  assert.equal(r.provider, 'openai')
  assert.equal(r.ok, true)
})

test('anthropic wins by default when both keys are present', () => {
  const r = detectAuth({ OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y' })
  assert.equal(r.provider, 'anthropic')
})

test('FBAY_LLM_PROVIDER forces the choice either way', () => {
  const both = { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y' }
  assert.equal(detectAuth({ ...both, FBAY_LLM_PROVIDER: 'openai' }).provider, 'openai')
  assert.equal(detectAuth({ ...both, FBAY_LLM_PROVIDER: 'anthropic' }).provider, 'anthropic')
})

test('forcing a provider with no credential fails loudly rather than falling back', () => {
  const r = detectAuth({ OPENAI_API_KEY: 'sk-x', FBAY_LLM_PROVIDER: 'anthropic' })
  assert.equal(r.ok, false)
  assert.match(r.detail, /FBAY_LLM_PROVIDER=anthropic/)
})

test('createLlm returns the provider matching the available credential', () => {
  assert.equal(createLlm({ env: { OPENAI_API_KEY: 'sk-x' }, apiKey: 'sk-x' }).provider, 'openai')
  assert.equal(createLlm({ env: { ANTHROPIC_API_KEY: 'sk-y' }, apiKey: 'sk-y' }).provider, 'anthropic')
})
