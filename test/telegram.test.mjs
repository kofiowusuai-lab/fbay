import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDealCard, createTelegramNotifier, escapeMd } from '../src/notify/telegram.mjs'

const DEAL = {
  listing: { title: 'MacBook Air 13 2019', priceCents: 12000, url: 'https://fb/1', city: 'Brooklyn, NY', imageUrls: ['https://img/1.jpg'] },
  identity: { brand: 'Apple', model: 'MacBook Air', variant: '13', capacity: '256GB', condition: 'good', identityConfidence: 0.9, category: 'laptop' },
  compset: { trimmedMedianCents: 30000, p25Cents: 28000, p75Cents: 32000, sampleN: 10, activeCount: 12, sellThrough: 0.45, confidence: 0.8 },
  profit: { netCents: 11945, roi: 0.995, breakevenBuyCents: 23945, shippingCents: 1650, fvfCents: 3975, perOrderCents: 30, promotedCents: 0, bufferCents: 1500 },
  score: 0.72,
}

// Note: the card is MarkdownV2, so "." is backslash-escaped in the output.
// These patterns match the escaped form on purpose. Asserting on the unescaped
// text would pass against a card that Telegram then rejects with a 400.
test('the card leads with the offer ceiling, because that is the actionable number', () => {
  const text = formatDealCard(DEAL)
  const firstNumberLine = text.split('\n').find((l) => /\$/.test(l))
  assert.match(firstNumberLine, /Offer up to/i)
  assert.match(firstNumberLine, /\$239\\\.45/)
})

test('the card includes net, roi, sell-through and comp count', () => {
  const text = formatDealCard(DEAL)
  assert.match(text, /\$119\\\.45/)
  assert.match(text, /100%/)          // roi
  assert.match(text, /45%/)           // sell-through
  assert.match(text, /10 comps/)
})

test('the card includes the listing link', () => {
  assert.match(formatDealCard(DEAL), /https:\/\/fb\/1/)
})

test('a price drop is called out', () => {
  const text = formatDealCard({ ...DEAL, priceDrop: { previousPriceCents: 20000, currentPriceCents: 12000 } })
  assert.match(text, /dropped/i)
  assert.match(text, /\$200\\\.00/)
})

test('escapeMd escapes MarkdownV2 reserved characters', () => {
  assert.equal(escapeMd('a-b.c(d)'), 'a\\-b\\.c\\(d\\)')
})

test('the notifier sends a photo when an image is available', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push({ u: String(u), o }); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyDeal(DEAL)
  assert.match(calls[0].u, /sendPhoto/)
  assert.equal(JSON.parse(calls[0].o.body).photo, 'https://img/1.jpg')
})

test('the notifier falls back to sendMessage with no image', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push({ u: String(u), o }); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyDeal({ ...DEAL, listing: { ...DEAL.listing, imageUrls: [] } })
  assert.match(calls[0].u, /sendMessage/)
})

test('a photo send failure falls back to a text message rather than losing the alert', async () => {
  const calls = []
  const n = createTelegramNotifier({
    token: 't', chatId: '1',
    fetchImpl: async (u, o) => {
      calls.push(String(u))
      if (String(u).includes('sendPhoto')) return { ok: false, status: 400, text: async () => 'bad photo' }
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  const r = await n.notifyDeal(DEAL)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /sendMessage/)
})

test('notifyAlert sends an operational warning', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyAlert('eBay sold parser returned zero results')
  assert.match(calls[0].text, /parser returned zero/)
})

test('a missing token disables the notifier instead of crashing the run', async () => {
  const n = createTelegramNotifier({ token: null, chatId: null })
  const r = await n.notifyDeal(DEAL)
  assert.equal(r.ok, false)
  assert.match(r.error, /not configured/)
})
