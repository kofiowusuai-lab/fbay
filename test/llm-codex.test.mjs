import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, schemaToPrompt, isAvailable, createCodexLlmClient, runCodex } from '../src/llm-codex.mjs'
import { IDENTITY_SCHEMA } from '../src/identify/extract.mjs'

test('extractJson handles a bare object', () => {
  assert.deepEqual(extractJson('{"brand":"Apple"}').data, { brand: 'Apple' })
})

test('extractJson strips code fences', () => {
  assert.deepEqual(extractJson('```json\n{"brand":"Apple"}\n```').data, { brand: 'Apple' })
  assert.deepEqual(extractJson('```\n{"brand":"Apple"}\n```').data, { brand: 'Apple' })
})

test('extractJson digs the object out of surrounding prose', () => {
  const r = extractJson('Here is the result:\n{"brand":"Apple","model":"X"}\nHope that helps!')
  assert.equal(r.ok, true)
  assert.equal(r.data.model, 'X')
})

test('extractJson reports failure rather than throwing', () => {
  assert.equal(extractJson('no json at all').ok, false)
  assert.equal(extractJson('{broken').ok, false)
  assert.equal(extractJson('').ok, false)
})

test('schemaToPrompt lists every key with its enum options', () => {
  const p = schemaToPrompt(IDENTITY_SCHEMA)
  for (const k of Object.keys(IDENTITY_SCHEMA.properties)) assert.match(p, new RegExp(`"${k}"`))
  assert.match(p, /"for_parts"/, 'condition enum must be spelled out')
  assert.match(p, /string\[\]/, 'array types must be shown as arrays')
})

test('isAvailable detects subscription auth', () => {
  const fsImpl = { readFileSync: () => JSON.stringify({ auth_mode: 'chatgpt', tokens: { a: 1 } }) }
  const r = isAvailable({ homedir: '/h', fsImpl })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'subscription')
  assert.match(r.detail, /no API credits/)
})

test('isAvailable reports unauthenticated codex without throwing', () => {
  const fsImpl = { readFileSync: () => { throw new Error('ENOENT') } }
  const r = isAvailable({ homedir: '/h', fsImpl })
  assert.equal(r.ok, false)
  assert.match(r.detail, /codex login/)
})

function fakeFs (store) {
  return {
    mkdirSync: () => {},
    writeFileSync: (p, d) => { store[p] = d },
    existsSync: (p) => p in store,
    readFileSync: (p) => store[p],
    rmSync: () => {},
  }
}

test('images are written to disk and passed with -i', async () => {
  const store = {}
  let seenArgs = null
  const c = createCodexLlmClient({
    fsImpl: fakeFs(store),
    runImpl: async (bin, args) => {
      seenArgs = args
      const out = args[args.indexOf('-o') + 1]
      store[out] = '{"brand":"Apple"}'
      return { ok: true }
    },
  })
  const r = await c.extractStructured({
    system: 's', user: 'u', schema: IDENTITY_SCHEMA,
    images: [{ mediaType: 'image/jpeg', base64: Buffer.from('x').toString('base64') }],
  })
  assert.equal(r.ok, true)
  assert.equal(seenArgs.filter((a) => a === '-i').length, 1)
  assert.ok(seenArgs.includes('--skip-git-repo-check'), 'must work outside a git repo')
  assert.ok(seenArgs.includes('read-only'), 'sandbox must stay read-only')
})

test('a non-JSON reply is retried, then reported', async () => {
  const store = {}
  let calls = 0
  const c = createCodexLlmClient({
    fsImpl: fakeFs(store),
    retries: 1,
    runImpl: async (bin, args) => {
      calls++
      store[args[args.indexOf('-o') + 1]] = 'I am not going to answer in JSON'
      return { ok: true }
    },
  })
  const r = await c.extractStructured({ system: 's', user: 'u', schema: IDENTITY_SCHEMA })
  assert.equal(r.ok, false)
  assert.equal(calls, 2, 'one retry')
  assert.match(r.error, /no JSON object/)
})

test('a timeout is reported clearly, not as a crash', async () => {
  const c = createCodexLlmClient({
    fsImpl: fakeFs({}),
    retries: 0,
    timeoutMs: 5000,
    runImpl: async () => ({ ok: false, error: 'timed out after 5s' }),
  })
  const r = await c.extractStructured({ system: 's', user: 'u', schema: IDENTITY_SCHEMA })
  assert.equal(r.ok, false)
  assert.match(r.error, /timed out after 5s/)
})

test('runCodex closes stdin - an open stdin makes codex exec hang forever', async () => {
  let opts = null
  const fakeChild = {
    stderr: { on: () => {} },
    on: (ev, cb) => { if (ev === 'close') setImmediate(() => cb(0)) },
    kill: () => {},
  }
  const r = await runCodex('codex', ['exec'], {
    cwd: '/tmp', timeoutMs: 1000,
    spawnImpl: (bin, args, o) => { opts = o; return fakeChild },
  })
  assert.equal(r.ok, true)
  assert.equal(opts.stdio[0], 'ignore', 'stdin must be closed, not inherited or piped')
})

test('runCodex reports a non-zero exit with stderr context', async () => {
  const fakeChild = {
    stderr: { on: (ev, cb) => cb(Buffer.from('boom')) },
    on: (ev, cb) => { if (ev === 'close') setImmediate(() => cb(1)) },
    kill: () => {},
  }
  const r = await runCodex('codex', [], { cwd: '/tmp', timeoutMs: 1000, spawnImpl: () => fakeChild })
  assert.equal(r.ok, false)
  assert.match(r.error, /exit 1: boom/)
})

test('runCodex kills the child on timeout and settles once', async () => {
  let killed = false
  const fakeChild = { stderr: { on: () => {} }, on: () => {}, kill: () => { killed = true } }
  const r = await runCodex('codex', [], { cwd: '/tmp', timeoutMs: 20, spawnImpl: () => fakeChild })
  assert.equal(r.ok, false)
  assert.match(r.error, /timed out after 0.02s/)
  assert.equal(killed, true)
})
