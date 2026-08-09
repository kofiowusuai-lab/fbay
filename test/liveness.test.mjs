import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPage, verifyLive } from '../src/source/liveness.mjs'

test('facebook removal wording is detected', () => {
  // The exact string a dead Marketplace listing shows.
  assert.equal(classifyPage({ bodyText: 'This listing no longer exists.\nBack' }).live, false)
  assert.equal(classifyPage({ bodyText: "Sorry, this content isn't available right now" }).live, false)
})

test('gumtree removal wording is detected', () => {
  assert.equal(classifyPage({ bodyText: 'This ad has expired' }).live, false)
  assert.equal(classifyPage({ bodyText: 'Ad not found' }).live, false)
})

test('a sold listing counts as gone', () => {
  assert.equal(classifyPage({ bodyText: 'DeWalt drill\nMarked as sold\nLondon' }).live, false)
})

test('404 and 410 are gone without reading the body', () => {
  assert.equal(classifyPage({ status: 404 }).live, false)
  assert.equal(classifyPage({ status: 410 }).live, false)
})

test('a normal listing page is live', () => {
  assert.equal(classifyPage({ bodyText: 'DeWalt DCD796 Combi Drill\n£85\nLondon\nMessage seller' }).live, true)
})

test('a navigation failure never suppresses a real deal', async () => {
  // A false negative costs money; a false positive costs one wasted tap.
  const session = { goto: async () => ({ ok: false, error: 'timeout' }) }
  const r = await verifyLive('https://x/1', session)
  assert.equal(r.live, true)
  assert.equal(r.checked, false)
})

test('a thrown error also fails open', async () => {
  const session = { goto: async () => { throw new Error('boom') } }
  assert.equal((await verifyLive('https://x/1', session)).live, true)
})

test('a checkpoint fails open rather than binning the deal', async () => {
  const session = { goto: async () => ({ ok: true, bodyText: '', block: { blocked: true, kind: 'checkpoint' } }) }
  const r = await verifyLive('https://x/1', session)
  assert.equal(r.live, true)
  assert.equal(r.checked, false)
})

test('a dead page is reported as not live', async () => {
  const session = { goto: async () => ({ ok: true, bodyText: 'This listing no longer exists.', block: { blocked: false } }) }
  const r = await verifyLive('https://x/1', session)
  assert.equal(r.live, false)
  assert.equal(r.checked, true)
  assert.match(r.reason, /removed/)
})
