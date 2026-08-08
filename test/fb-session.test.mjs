import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectBlock, EXTRACT_NODES_FN, isLoggedInFromText } from '../src/source/facebook/session.mjs'

test('detectBlock recognises a login wall', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/login/?next=x', bodyText: 'Log in to Facebook' })
  assert.equal(r.blocked, true)
  assert.equal(r.kind, 'login_wall')
})

test('detectBlock recognises a checkpoint', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/checkpoint/12345', bodyText: 'anything' })
  assert.equal(r.blocked, true)
  assert.equal(r.kind, 'checkpoint')
})

test('detectBlock recognises a rate-limit interstitial by body text', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/marketplace/nyc/search', bodyText: 'You’re temporarily blocked from using this feature' })
  assert.equal(r.blocked, true)
  assert.equal(r.kind, 'temporarily_blocked')
})

test('detectBlock passes a normal marketplace page', () => {
  const r = detectBlock({ url: 'https://www.facebook.com/marketplace/nyc/search?query=x', bodyText: 'Today’s picks $250 MacBook' })
  assert.equal(r.blocked, false)
})

test('isLoggedInFromText is false when the login form is present', () => {
  assert.equal(isLoggedInFromText('Log into Facebook Email or phone Password'), false)
  assert.equal(isLoggedInFromText('Marketplace Today’s picks Sell'), true)
})

test('EXTRACT_NODES_FN is a self-contained function source string for page.evaluate', () => {
  assert.equal(typeof EXTRACT_NODES_FN, 'function')
  // It must not close over anything from this module - it runs in the page context.
  assert.ok(!/import |require\(/.test(EXTRACT_NODES_FN.toString()))
})
