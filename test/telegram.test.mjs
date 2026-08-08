import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDealCard, createTelegramNotifier, escapeHtml, pickEvidence } from '../src/notify/telegram.mjs'

const DEAL = {
  listing: { title: 'MacBook Air 13 2019', priceCents: 12000, url: 'https://fb/1', city: 'Brooklyn, NY', imageUrls: ['https://img/1.jpg'] },
  identity: { brand: 'Apple', model: 'MacBook Air', variant: '13', capacity: '256GB', condition: 'good', identityConfidence: 0.9, category: 'laptop', query: 'apple macbook air 13 256gb' },
  compset: { trimmedMedianCents: 30000, p25Cents: 28000, p75Cents: 32000, sampleN: 10, activeCount: 12, sellThrough: 0.45, confidence: 0.8 },
  profit: { netCents: 11945, roi: 0.995, breakevenBuyCents: 23945, shippingCents: 1650, fvfCents: 3975, perOrderCents: 30, promotedCents: 0, bufferCents: 1500 },
  score: 0.72,
}

// Note: the card is MarkdownV2, so "." is backslash-escaped in the output.
// These patterns match the escaped form on purpose. Asserting on the unescaped
// text would pass against a card that Telegram then rejects with a 400.
test('the card leads with the offer ceiling, because that is the actionable number', () => {
  const text = formatDealCard(DEAL)
  const firstBold = text.split('\n').find((l) => /OFFER UP TO/.test(l))
  assert.ok(firstBold, 'the offer ceiling must be present')
  assert.match(firstBold, /\$239\.45/)
})

test('the card states the eBay sell price and the comp count', () => {
  const text = formatDealCard(DEAL)
  assert.match(text, /Sell on eBay around \$300\.00/)
  assert.match(text, /10 sold/)
  assert.match(text, /45%/)
})

test('the card carries a clickable Facebook buy link', () => {
  const text = formatDealCard(DEAL)
  assert.match(text, /<a href="https:\/\/fb\/1">/)
  assert.match(text, /BUY ON FACEBOOK/)
})

test('the card includes real sold eBay listings as evidence', () => {
  const comps = [
    { included: 1, url: 'https://ebay.com/itm/1', title: 'Apple MacBook Air M1 256GB', price_cents: 30100, sold_at: Date.UTC(2026, 6, 1) },
    { included: 1, url: 'https://ebay.com/itm/2', title: 'Apple MacBook Air M1 256GB Gold', price_cents: 29900, sold_at: Date.UTC(2026, 6, 5) },
    { included: 1, url: 'https://ebay.com/itm/3', title: 'Apple MacBook Air M1 256GB Silver', price_cents: 30500, sold_at: Date.UTC(2026, 6, 9) },
    { included: 0, url: 'https://ebay.com/itm/4', title: 'Lot of 3 MacBook', price_cents: 90000, sold_at: null },
  ]
  const text = formatDealCard({ ...DEAL, comps })
  assert.match(text, /Recently sold:/)
  assert.match(text, /ebay\.com\/itm\/1/)
  assert.match(text, /ebay\.com\/itm\/2/)
  assert.match(text, /ebay\.com\/itm\/3/)
  assert.ok(!text.includes('itm/4'), 'excluded comps are not evidence')
})

test('evidence is the comps nearest the median, capped at three', () => {
  const comps = Array.from({ length: 10 }, (_, i) => ({
    included: 1, url: `https://ebay.com/itm/${i}`, title: `comp ${i}`,
    price_cents: 20000 + i * 2500, sold_at: null,
  }))
  const picked = pickEvidence(comps, 30000)
  assert.equal(picked.length, 3)
  for (const p of picked) assert.ok(Math.abs(p.price_cents - 30000) <= 5000, 'far outliers are poor evidence')
})

test('the card links an eBay sold search so the median can be checked', () => {
  const text = formatDealCard(DEAL)
  assert.match(text, /LH_Sold=1/)
  assert.match(text, /see all sold on eBay/)
})

test('a price drop is called out', () => {
  const text = formatDealCard({ ...DEAL, priceDrop: { previousPriceCents: 20000, currentPriceCents: 12000 } })
  assert.match(text, /dropped/i)
  assert.match(text, /\$200\.00/)
})

test('html special characters in listing text cannot break the message', () => {
  // A raw < from a seller's title would make Telegram reject the whole message
  // with a 400, losing the alert entirely.
  const text = formatDealCard({
    ...DEAL,
    identity: { ...DEAL.identity, brand: null, model: null, variant: null, capacity: null },
    listing: { ...DEAL.listing, title: 'Drill <b>& "best"</b> deal' },
  })
  assert.match(text, /Drill &lt;b&gt;&amp; "best"&lt;\/b&gt; deal/)
})

test('the notifier sends a photo when an image is available', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push({ u: String(u), o }); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyDeal(DEAL)
  assert.match(calls[0].u, /sendPhoto/)
  assert.equal(JSON.parse(calls[0].o.body).photo, 'https://img/1.jpg')
  assert.match(calls[1].u, /sendMessage/, 'the full card follows as its own message, uncapped by the caption limit')
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

test('notifyAlert sends a critical operational warning', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) } } })
  await n.notifyAlert('eBay sold parser returned zero results', { level: 'critical' })
  assert.match(calls[0].text, /parser returned zero/)
})

test('a missing token disables the notifier instead of crashing the run', async () => {
  const n = createTelegramNotifier({ token: null, chatId: null })
  const r = await n.notifyDeal(DEAL)
  assert.equal(r.ok, false)
  assert.match(r.error, /not configured/)
})

test('a network failure returns an error instead of throwing', async () => {
  // A throw here would propagate out of notifyDeal and kill the monitor loop.
  const n = createTelegramNotifier({
    token: 't', chatId: '1', retries: 1, sleepImpl: async () => {},
    fetchImpl: async () => { throw new Error('ETIMEDOUT 149.154.166.110:443') },
  })
  const r = await n.notifyDeal({ ...DEAL, listing: { ...DEAL.listing, imageUrls: [] } })
  assert.equal(r.ok, false)
  assert.match(r.error, /unreachable/)
  assert.match(r.error, /ETIMEDOUT/)
})

test('a transient network failure is retried and can succeed', async () => {
  let n = 0
  const notifier = createTelegramNotifier({
    token: 't', chatId: '1', retries: 3, sleepImpl: async () => {},
    fetchImpl: async () => {
      if (++n < 3) throw new Error('ETIMEDOUT')
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  const r = await notifier.notifyAlert('x', { level: 'critical' })
  assert.equal(r.ok, true)
  assert.equal(n, 3)
})

test('a 4xx is not retried - retrying a misconfiguration wastes time', async () => {
  let calls = 0
  const notifier = createTelegramNotifier({
    token: 't', chatId: '1', retries: 3, sleepImpl: async () => {},
    fetchImpl: async () => { calls++; return { ok: false, status: 403, text: async () => 'bot cannot message the bot' } },
  })
  const r = await notifier.notifyAlert('x', { level: 'critical' })
  assert.equal(r.ok, false)
  assert.equal(calls, 1)
  assert.match(r.error, /403/)
})

test('a 5xx is retried', async () => {
  let calls = 0
  const notifier = createTelegramNotifier({
    token: 't', chatId: '1', retries: 2, sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++
      if (calls < 3) return { ok: false, status: 502, text: async () => 'bad gateway' }
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  assert.equal((await notifier.notifyAlert('x', { level: 'critical' })).ok, true)
  assert.equal(calls, 3)
})

test('a near-miss card is labelled and states the single failed check', () => {
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
  const text = formatDealCard({ ...DEAL, nearMiss: 'sell-through 12% below floor 35%' })
  assert.match(text, /NEAR MISS/)
  assert.match(text, /not a buy/)
  assert.match(text, /sell-through 12%/)
  assert.ok(typeof n.notifyNearMiss === 'function')
})

test('routine operational messages are suppressed by default', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push(o); return { ok: true, json: async () => ({}) } } })
  const r = await n.notifyAlert('scanning watch 3 of 15')
  assert.equal(r.skipped, true)
  assert.equal(calls.length, 0, 'the deals chat must not fill with status')
})

test('critical operational messages still get through', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', fetchImpl: async (u, o) => { calls.push(o); return { ok: true, json: async () => ({}) } } })
  await n.notifyAlert('canary failure - parser returned zero results', { level: 'critical' })
  assert.equal(calls.length, 1, 'a broken scraper must never be silent')
})

test("operational: 'none' silences even critical warnings", async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', operational: 'none', fetchImpl: async (u, o) => { calls.push(o); return { ok: true, json: async () => ({}) } } })
  await n.notifyAlert('blocked', { level: 'critical' })
  assert.equal(calls.length, 0)
})

test('deals are never suppressed by the operational setting', async () => {
  const calls = []
  const n = createTelegramNotifier({ token: 't', chatId: '1', operational: 'none', fetchImpl: async (u, o) => { calls.push(o); return { ok: true, json: async () => ({}) } } })
  await n.notifyDeal({ ...DEAL, listing: { ...DEAL.listing, imageUrls: [] } })
  assert.equal(calls.length, 1, 'the whole point of the chat')
})
