import { soldSearchUrl } from '../comps/ebay-sold.mjs'

/**
 * HTML rather than MarkdownV2. MarkdownV2 requires escaping 18 characters
 * including "-", "(", ")" and "." — which appear in every price, every title
 * and every eBay URL — and one missed escape rejects the whole message with a
 * 400. HTML needs three, and inline links survive URLs with query strings.
 */
export function escapeHtml (s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function link (url, text) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
}

const SYMBOLS = { USD: '$', GBP: '\u00A3', EUR: '\u20AC', CAD: 'C$', AUD: 'A$' }

function money (cents, currency = 'USD') {
  return cents == null ? 'n/a' : `${SYMBOLS[currency] ?? '$'}${(cents / 100).toFixed(2)}`
}

function pct (x) {
  return x == null ? 'n/a' : `${Math.round(x * 100)}%`
}

/**
 * How old the listing was when found. A good deal at a low ask is gone in
 * minutes, so "posted 3 hours ago" and "posted 6 minutes ago" call for very
 * different urgency - and without it every alert reads equally fresh.
 */
function ageLine (listedAt, seenAt) {
  if (!listedAt) return null
  const mins = Math.round(((seenAt ?? Date.now()) - listedAt) / 60000)
  if (mins < 60) return `Posted ${mins}m before we saw it`
  const hrs = Math.round(mins / 60)
  return hrs < 48 ? `Posted ${hrs}h before we saw it` : `Posted ${Math.round(hrs / 24)}d before we saw it`
}

function soldDate (ts) {
  if (!ts) return ''
  return ` · ${new Date(ts).toISOString().slice(0, 10)}`
}

/**
 * Pick the comps that best justify the valuation: the ones closest to the
 * median. Extremes at either end are the least persuasive evidence — a buyer
 * checking the number wants to see the middle of the distribution, not its
 * tails.
 */
export function pickEvidence (comps = [], medianCents, n = 3) {
  return comps
    .filter((c) => (c.included === 1 || c.included === true) && c.url && c.price_cents != null)
    .sort((a, b) => Math.abs(a.price_cents - medianCents) - Math.abs(b.price_cents - medianCents))
    .slice(0, n)
    .sort((a, b) => b.price_cents - a.price_cents)
}

export function formatDealCard ({ listing, identity, compset, profit, score, priceDrop, comps = [], nearMiss = null, currency = 'USD', marketplace = 'EBAY_US' }) {
  const m = (c) => money(c, currency)
  const name = [identity.brand, identity.model, identity.variant, identity.capacity].filter(Boolean).join(' ')
  const out = []

  if (nearMiss) out.push('<b>NEAR MISS</b> — not a buy, one check failed:', escapeHtml(nearMiss), '')
  out.push(`<b>${escapeHtml(name || listing.title)}</b>`)
  out.push(escapeHtml(`${identity.condition} · ${identity.category} · ${pct(identity.identityConfidence)} sure`))
  out.push('')

  if (priceDrop) out.push(escapeHtml(`Price dropped from ${m(priceDrop.previousPriceCents)}`), '')

  const age = ageLine(listing.listedAt, listing.seenAt)
  if (age) out.push(escapeHtml(`${age} · act fast`), '')

  out.push(`<b>OFFER UP TO ${escapeHtml(m(profit.breakevenBuyCents))}</b>`)
  out.push(escapeHtml(`They are asking ${m(listing.priceCents)} · net ${m(profit.netCents)} · ROI ${pct(profit.roi)}`))
  out.push('')

  out.push(`<b>Sell on eBay around ${escapeHtml(m(compset.trimmedMedianCents))}</b>`)
  out.push(escapeHtml(`Range ${m(compset.p25Cents)}-${m(compset.p75Cents)} from ${compset.sampleN} sold`))
  out.push(escapeHtml(`Sell-through ${pct(compset.sellThrough)} · ${compset.activeCount} listed now`))

  const evidence = pickEvidence(comps, compset.trimmedMedianCents)
  if (evidence.length) {
    out.push('', '<b>Recently sold:</b>')
    for (const c of evidence) {
      out.push(`• ${link(c.url, `${m(c.price_cents)} — ${String(c.title).slice(0, 52)}`)}${escapeHtml(soldDate(c.sold_at))}`)
    }
  }

  out.push('')
  out.push(escapeHtml(`Fees ${m(profit.fvfCents + profit.perOrderCents + profit.promotedCents)} · ship ${m(profit.shippingCents)} · buffer ${m(profit.bufferCents)}`))
  if (listing.city) out.push(escapeHtml(listing.city))

  out.push('')
  out.push(link(listing.url, '➜ BUY ON FACEBOOK'))
  if (identity.query) out.push(link(soldSearchUrl(identity.query, { marketplace }), 'see all sold on eBay'))

  return out.join('\n')
}

export function createTelegramNotifier ({
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl = globalThis.fetch,
  retries = 3,
  timeoutMs = 15000,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  operational = 'critical',
} = {}) {
  const configured = Boolean(token && chatId)
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`

  /**
   * Network failures must NOT throw. This runs inside the monitor loop, so an
   * unreachable Telegram (a dropped connection at 3am, an ISP hiccup) would
   * otherwise take down the whole run and lose the deal that triggered it.
   * A missed alert is recoverable; a dead monitor is not.
   */
  async function send (method, body, { attempt = 0 } = {}) {
    try {
      const res = await fetchImpl(api(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) return { ok: true }
      const detail = `telegram ${method} failed: ${res.status} ${(await res.text()).slice(0, 160)}`
      // 4xx is a configuration problem; retrying will not help.
      if (res.status < 500 || attempt >= retries) return { ok: false, error: detail }
      await sleepImpl(1000 * 2 ** attempt)
      return send(method, body, { attempt: attempt + 1 })
    } catch (e) {
      const detail = `telegram ${method} unreachable: ${e.message ?? String(e)}`
      if (attempt >= retries) return { ok: false, error: detail }
      await sleepImpl(1000 * 2 ** attempt)
      return send(method, body, { attempt: attempt + 1 })
    }
  }

  async function notifyNearMiss (deal) {
    return notifyDeal({ ...deal, nearMiss: deal.rejections?.[0]?.reason ?? 'one filter failed' })
  }

  async function notifyDeal (deal) {
    if (!configured) return { ok: false, error: 'telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' }
    const text = formatDealCard(deal)
    const photo = (deal.listing.imageUrls ?? [])[0]

    // A photo caption is capped at 1024 characters and the evidence list can
    // exceed it, so send the photo and the full card as separate messages
    // rather than silently truncating the links.
    if (photo) {
      await send('sendPhoto', { chat_id: chatId, photo, caption: deal.listing.title?.slice(0, 200) ?? 'deal' })
    }
    return send('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }

  /**
   * Operational messages, NOT deals. These are noise in a chat the operator
   * only wants to open when there is something to buy, so routine ones are off
   * by default and only `critical` gets through - a broken scraper or a blocked
   * account, where silence would otherwise be indistinguishable from a quiet
   * market.
   */
  async function notifyAlert (message, { level = 'routine' } = {}) {
    if (!configured) return { ok: false, error: 'telegram not configured' }
    if (operational === 'none') return { ok: true, skipped: true }
    if (operational === 'critical' && level !== 'critical') return { ok: true, skipped: true }
    return send('sendMessage', { chat_id: chatId, text: escapeHtml(`FBAY: ${message}`), parse_mode: 'HTML' })
  }

  return { configured, notifyDeal, notifyNearMiss, notifyAlert }
}
