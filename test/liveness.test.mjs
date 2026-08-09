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

test("facebook desktop wording is detected, not just the mobile string", () => {
  // Captured verbatim from a real removed listing loaded in the browser the
  // scraper actually uses. Only matching the mobile app's wording let removed
  // listings through as live.
  const desktop = "1 unread chats\n1\nNumber of unread notifications\n20+\nThis page isn't available\nThe link may be broken, or the page may have been removed. Check to see if the link you're trying to open is correct."
  const r = classifyPage({ bodyText: desktop })
  assert.equal(r.live, false)
  assert.match(r.reason, /removed/)
})

test('the mobile wording still matches', () => {
  assert.equal(classifyPage({ bodyText: 'This listing no longer exists.\nBack' }).live, false)
})

test('a real live listing is not caught by the wider patterns', () => {
  // The widened markers must not start binning good listings.
  const live = 'Marketplace\nDeWalt DCD796 Combi Drill 18V\n£85\nListed 2 hours ago in London\nCondition: Used - Good\nMessage seller\nSave\nShare\nAvailable'
  assert.equal(classifyPage({ bodyText: live }).live, true)
})

test('description text does not accidentally trip the removal markers', () => {
  // The markers match contiguous phrases, so a seller writing around those
  // words does not get their live listing suppressed.
  const cases = [
    'Vintage lamp\n£20\nSeller notes: the link in my other ad may be broken',
    'Drill\n£40\nThis page isn\'t the one I meant to post',
    'Camera\n£90\nNo longer available in shops, brand new',
  ]
  for (const t of cases) assert.equal(classifyPage({ bodyText: t }).live, true, t.slice(0, 40))
})
