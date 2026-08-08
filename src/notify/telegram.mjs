const MD_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g

export function escapeMd (s) {
  return String(s ?? '').replace(MD_RESERVED, (c) => `\\${c}`)
}

function money (cents) {
  return cents == null ? 'n/a' : `$${(cents / 100).toFixed(2)}`
}

function pct (x) {
  return x == null ? 'n/a' : `${Math.round(x * 100)}%`
}

export function formatDealCard ({ listing, identity, compset, profit, score, priceDrop }) {
  const name = [identity.brand, identity.model, identity.variant, identity.capacity].filter(Boolean).join(' ')
  const lines = [
    `*${escapeMd(name || listing.title)}*`,
    escapeMd(`${identity.condition} · ${identity.category} · ${pct(identity.identityConfidence)} sure`),
    '',
    escapeMd(`Offer up to ${money(profit.breakevenBuyCents)}   (asking ${money(listing.priceCents)})`),
    escapeMd(`Net ${money(profit.netCents)} · ROI ${pct(profit.roi)} · score ${score.toFixed(2)}`),
    '',
    escapeMd(`Sells for ${money(compset.trimmedMedianCents)} (${money(compset.p25Cents)}-${money(compset.p75Cents)}, ${compset.sampleN} comps)`),
    escapeMd(`Sell-through ${pct(compset.sellThrough)} · ${compset.activeCount} active`),
    escapeMd(`Fees ${money(profit.fvfCents + profit.perOrderCents + profit.promotedCents)} · ship ${money(profit.shippingCents)} · buffer ${money(profit.bufferCents)}`),
  ]
  if (priceDrop) {
    lines.splice(3, 0, escapeMd(`Price dropped from ${money(priceDrop.previousPriceCents)}`), '')
  }
  if (listing.city) lines.push(escapeMd(listing.city))
  lines.push('', escapeMd(listing.url))
  return lines.join('\n')
}

export function createTelegramNotifier ({
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl = globalThis.fetch,
} = {}) {
  const configured = Boolean(token && chatId)
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`

  async function send (method, body) {
    const res = await fetchImpl(api(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, error: `telegram ${method} failed: ${res.status} ${await res.text()}` }
    return { ok: true }
  }

  async function notifyDeal (deal) {
    if (!configured) return { ok: false, error: 'telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' }
    const text = formatDealCard(deal)
    const photo = (deal.listing.imageUrls ?? [])[0]

    if (photo) {
      const r = await send('sendPhoto', { chat_id: chatId, photo, caption: text, parse_mode: 'MarkdownV2' })
      if (r.ok) return r
      // A dead image URL must not cost us the alert.
    }
    return send('sendMessage', { chat_id: chatId, text, parse_mode: 'MarkdownV2', disable_web_page_preview: false })
  }

  async function notifyAlert (message) {
    if (!configured) return { ok: false, error: 'telegram not configured' }
    return send('sendMessage', { chat_id: chatId, text: escapeMd(`FBAY ALERT: ${message}`), parse_mode: 'MarkdownV2' })
  }

  return { configured, notifyDeal, notifyAlert }
}
