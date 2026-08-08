import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLlmClient, MODELS, detectAuth } from '../src/llm.mjs'

function fakeAnthropic (responses) {
  const calls = []
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req)
        const r = responses.shift()
        if (r instanceof Error) throw r
        return r
      },
    },
  }
}

const toolResponse = (input) => ({
  content: [{ type: 'tool_use', name: 'emit', input }],
  usage: { input_tokens: 10, output_tokens: 5 },
  model: MODELS.fast,
})

const SCHEMA = { type: 'object', properties: { brand: { type: 'string' } }, required: ['brand'] }

test('extractStructured returns the tool input', async () => {
  const client = createLlmClient({ anthropic: fakeAnthropic([toolResponse({ brand: 'Apple' })]) })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, true)
  assert.equal(r.data.brand, 'Apple')
})

test('the request forces the tool so the model cannot answer in prose', async () => {
  const api = fakeAnthropic([toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api })
  await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.deepEqual(api.calls[0].tool_choice, { type: 'tool', name: 'emit' })
  assert.deepEqual(api.calls[0].tools[0].input_schema, SCHEMA)
})

test('images are attached as base64 content blocks', async () => {
  const api = fakeAnthropic([toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api })
  await client.extractStructured({
    system: 's', user: 'u', schema: SCHEMA,
    images: [{ mediaType: 'image/jpeg', base64: 'AAAA' }],
  })
  const content = api.calls[0].messages[0].content
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].source.media_type, 'image/jpeg')
  assert.equal(content[content.length - 1].type, 'text')
})

test('a response with no tool_use block is an error, not a crash', async () => {
  const client = createLlmClient({ anthropic: fakeAnthropic([{ content: [{ type: 'text', text: 'sorry' }] }]), retries: 0 })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, false)
  assert.match(r.error, /no structured output/i)
})

test('a transient API error is retried', async () => {
  const api = fakeAnthropic([new Error('overloaded'), toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api, retries: 2, sleepImpl: async () => {} })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, true)
  assert.equal(api.calls.length, 2)
})

test('retries are bounded and the last error is reported', async () => {
  const api = fakeAnthropic([new Error('boom'), new Error('boom'), new Error('boom')])
  const client = createLlmClient({ anthropic: api, retries: 2, sleepImpl: async () => {} })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
  assert.equal(api.calls.length, 3)
})

test('the model can be overridden per call for escalation', async () => {
  const api = fakeAnthropic([toolResponse({ brand: 'Apple' })])
  const client = createLlmClient({ anthropic: api })
  await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA, model: MODELS.smart })
  assert.equal(api.calls[0].model, MODELS.smart)
})

test('token usage is reported back for cost tracking', async () => {
  const client = createLlmClient({ anthropic: fakeAnthropic([toolResponse({ brand: 'Apple' })]) })
  const r = await client.extractStructured({ system: 's', user: 'u', schema: SCHEMA })
  assert.equal(r.usage.input_tokens, 10)
})

test('detectAuth prefers an explicit API key', () => {
  const r = detectAuth({ ANTHROPIC_API_KEY: 'sk-x' })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'api_key')
})

test('detectAuth falls back to ANTHROPIC_AUTH_TOKEN', () => {
  const r = detectAuth({ ANTHROPIC_AUTH_TOKEN: 'tok' })
  assert.equal(r.mode, 'auth_token')
})

test('detectAuth recognises an ant auth login OAuth profile', () => {
  const fakeFs = { existsSync: (p) => p === '/home/me/.config/anthropic/credentials' }
  const r = detectAuth({ HOME: '/home/me' }, fakeFs)
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'oauth_profile')
})

test('detectAuth reports every remedy when nothing is configured', () => {
  // fs is injected so the check cannot pick up real credentials on the machine.
  const noCreds = { existsSync: () => false, readFileSync: () => { throw new Error('ENOENT') } }
  const r = detectAuth({ HOME: '/home/me' }, noCreds)
  assert.equal(r.ok, false)
  assert.equal(r.provider, null)
  assert.match(r.detail, /ANTHROPIC_API_KEY/)
  assert.match(r.detail, /OPENAI_API_KEY/)
  assert.match(r.detail, /ant auth login/)
  assert.match(r.detail, /codex login/)
})

// Path-aware fake: codex authenticated, no anthropic oauth profile on disk.
const codexOnlyFs = {
  existsSync: (p) => String(p).includes('.codex'),
  readFileSync: (p) => {
    if (String(p).includes('.codex')) return JSON.stringify({ auth_mode: 'chatgpt', tokens: { a: 1 } })
    throw new Error('ENOENT')
  },
}

test('codex is selected when it is the only credential available', () => {
  const r = detectAuth({ HOME: '/home/me' }, codexOnlyFs)
  assert.equal(r.provider, 'codex')
  assert.equal(r.mode, 'subscription')
  assert.match(r.detail, /no API credits/)
})

test('an API provider is preferred over codex when both exist', () => {
  // Codex works but costs 5x the latency, so a metered key should win.
  assert.equal(detectAuth({ ANTHROPIC_API_KEY: 'k', HOME: '/h' }, codexOnlyFs).provider, 'anthropic')
  assert.equal(detectAuth({ OPENAI_API_KEY: 'k', HOME: '/h' }, codexOnlyFs).provider, 'openai')
})

test('FBAY_LLM_PROVIDER=codex overrides an available API key', () => {
  const r = detectAuth({ OPENAI_API_KEY: 'k', HOME: '/h', FBAY_LLM_PROVIDER: 'codex' }, codexOnlyFs)
  assert.equal(r.provider, 'codex')
})

test('the client does not pass an explicit undefined apiKey, which would break the profile path', () => {
  // Regression guard: `new Anthropic({apiKey: undefined})` stops the SDK
  // falling through to an OAuth profile on disk.
  const seen = []
  class FakeAnthropic { constructor (opts) { seen.push(opts) } }
  createLlmClient({ apiKey: undefined, anthropic: new FakeAnthropic({ sentinel: true }) })
  const real = createLlmClient.toString()
  assert.match(real, /apiKey \? \{ apiKey \} : \{\}/)
})
