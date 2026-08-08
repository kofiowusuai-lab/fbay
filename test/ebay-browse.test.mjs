import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowseClient, parseBrowseResponse } from '../src/comps/ebay-browse.mjs'

function fakeFetch (responses) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts })
    const r = responses.shift()
    if (!r) throw new Error('unexpected fetch')
    return {
      ok: r.status === undefined ? true : r.status < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    }
  }
  fn.calls = calls
  return fn
}

const TOKEN_RES = { body: { access_token: 'tok123', expires_in: 7200 } }

test('parseBrowseResponse maps items to cents and drops malformed rows', () => {
  const out = parseBrowseResponse({
    total: 412,
    itemSummaries: [
      { itemId: 'v1|1|0', title: 'iPhone 13', price: { value: '299.99', currency: 'USD' }, condition: 'Used', itemWebUrl: 'https://x' },
      { itemId: 'v1|2|0', title: 'no price' },
    ],
  })
  assert.equal(out.total, 412)
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].priceCents, 29999)
})

test('token is requested once and reused until expiry', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 1, itemSummaries: [] } }, { body: { total: 2, itemSummaries: [] } }])
  let t = 0
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => t })
  await c.searchActive('x')
  t = 1000
  await c.searchActive('y')
  const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('oauth2/token'))
  assert.equal(tokenCalls.length, 1)
})

test('token is re-requested after expiry', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 1, itemSummaries: [] } }, TOKEN_RES, { body: { total: 1, itemSummaries: [] } }])
  let t = 0
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => t })
  await c.searchActive('x')
  t = 8000 * 1000
  await c.searchActive('y')
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('oauth2/token')).length, 2)
})

test('token request uses HTTP Basic with base64 appId:certId', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 0, itemSummaries: [] } }])
  const c = createBrowseClient({ appId: 'APP', certId: 'CERT', fetchImpl, clock: () => 0 })
  await c.searchActive('x')
  const auth = fetchImpl.calls[0].opts.headers.Authorization
  assert.equal(auth, 'Basic ' + Buffer.from('APP:CERT').toString('base64'))
})

test('search sends the marketplace header and encodes the query', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { body: { total: 0, itemSummaries: [] } }])
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => 0, marketplace: 'EBAY_US' })
  await c.searchActive('iphone 13 128gb')
  const call = fetchImpl.calls[1]
  assert.match(call.url, /q=iphone%2013%20128gb/)
  assert.equal(call.opts.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US')
})

test('an API error returns ok:false rather than throwing', async () => {
  const fetchImpl = fakeFetch([TOKEN_RES, { status: 500, body: { error: 'boom' } }])
  const c = createBrowseClient({ appId: 'a', certId: 'b', fetchImpl, clock: () => 0, retries: 0 })
  const r = await c.searchActive('x')
  assert.equal(r.ok, false)
  assert.match(r.error, /500/)
})
