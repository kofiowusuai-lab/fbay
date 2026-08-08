import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offerPriceCents, buildDraftPrompt, draftOffer, DRAFT_SYSTEM } from '../src/notify/draft.mjs'

const CTX = {
  listing: { title: 'MacBook Air 13 2019', priceCents: 20000, city: 'Brooklyn, NY' },
  identity: { brand: 'Apple', model: 'MacBook Air', condition: 'good' },
  profit: { breakevenBuyCents: 23945, netCents: 3945 },
}

test('the offer sits below the ask and never above breakeven', () => {
  const o = offerPriceCents({ askCents: 20000, breakevenBuyCents: 23945, discount: 0.2 })
  assert.ok(o < 20000)
  assert.ok(o <= 23945)
  assert.equal(o % 500, 0, 'offers should land on a clean $5 increment')
})

test('the offer is capped at breakeven when the ask is already above it', () => {
  const o = offerPriceCents({ askCents: 40000, breakevenBuyCents: 23945, discount: 0.2 })
  assert.ok(o <= 23945)
})

test('the offer never goes below a floor fraction of the ask', () => {
  const o = offerPriceCents({ askCents: 10000, breakevenBuyCents: 90000, discount: 0.9, minFraction: 0.6 })
  assert.ok(o >= 6000)
})

test('the prompt carries the ask, the offer and the item', () => {
  const p = buildDraftPrompt({ ...CTX, offerCents: 16000 })
  assert.match(p, /\$200/)
  assert.match(p, /\$160/)
  assert.match(p, /MacBook Air/)
})

test('the system prompt forbids mentioning resale', () => {
  assert.match(DRAFT_SYSTEM, /never mention/i)
  assert.match(DRAFT_SYSTEM, /resell|resale|eBay/i)
})

test('draftOffer returns the message and the offer price', async () => {
  const llm = { completeText: async () => ({ ok: true, text: 'Hi, is this still available? Could you do $160 cash, I can pick up today.' }) }
  const r = await draftOffer({ ...CTX, llm })
  assert.equal(r.ok, true)
  assert.match(r.body, /160/)
  assert.ok(r.offerCents < 20000)
})

test('draftOffer strips surrounding quotes the model sometimes adds', async () => {
  const llm = { completeText: async () => ({ ok: true, text: '"Hi, is this available?"' }) }
  const r = await draftOffer({ ...CTX, llm })
  assert.equal(r.body, 'Hi, is this available?')
})

test('an llm failure falls back to a usable template rather than no message', async () => {
  const llm = { completeText: async () => ({ ok: false, error: 'down' }) }
  const r = await draftOffer({ ...CTX, llm })
  assert.equal(r.ok, true)
  assert.equal(r.fallback, true)
  assert.match(r.body, /still available/i)
  assert.match(r.body, /\$\d/)
})
