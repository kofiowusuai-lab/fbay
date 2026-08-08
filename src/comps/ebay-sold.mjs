import * as cheerio from 'cheerio'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Ordered selector strategies. The first that yields results wins.
// eBay has shipped both of these shapes; keeping both means a rollback on their
// side does not become an outage on ours.
//
// Price is scoped STRICTLY to the price container. An earlier version also
// matched `.su-styled-text.bold`, which picked up "17+ sold" and the crossed-out
// original price. Never widen these selectors to "whatever looks bold".
export const SELECTOR_STRATEGIES = [
  {
    name: 's-card',
    root: '.s-card',
    title: '.s-card__title',
    price: '.s-card__price',
    caption: '.s-card__caption, .s-card__subtitle',
    link: 'a.su-link, a',
  },
  {
    name: 's-item',
    root: 'li.s-item, .s-item__wrapper',
    title: '.s-item__title',
    price: '.s-item__price',
    caption: '.s-item__caption, .s-item__title--tagblock, .s-item__subtitle',
    link: 'a.s-item__link, a',
  },
]

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/**
 * Currency symbols and prefixes eBay renders, longest-first so "R$" is tested
 * before "$" and "C $" before "$".
 *
 * This matters more than it looks. eBay geolocates by IP: the same URL served
 * to a non-US address returns "R$ 1,249.09" for an item a US visitor sees as
 * "$249.09". Parsing that as 124909 US cents would value a $250 phone at $1,249
 * and make every listing look like a windfall. Currency is never assumed.
 */
const CURRENCY_PREFIXES = [
  ['R$', 'BRL'],
  ['C $', 'CAD'],
  ['CA$', 'CAD'],
  ['AU $', 'AUD'],
  ['AU$', 'AUD'],
  ['NZ $', 'NZD'],
  ['US $', 'USD'],
  ['US$', 'USD'],
  ['£', 'GBP'],
  ['€', 'EUR'],
  ['¥', 'JPY'],
  ['CHF', 'CHF'],
  ['$', 'USD'],
]

export function detectCurrency (text) {
  const s = String(text ?? '').trim()
  for (const [prefix, code] of CURRENCY_PREFIXES) {
    if (s.includes(prefix)) return code
  }
  return null
}

/**
 * Returns {cents, currency} or null. For a range ("$10.00 to $20.00") the low
 * end is used, because the low end is what actually sold at that price point.
 */
export function parsePrice (text) {
  if (!text) return null
  const currency = detectCurrency(text)
  const first = String(text).split(/\s+to\s+/i)[0]
  const m = first.match(/([\d.,]+)/)
  if (!m) return null

  // Normalise thousands/decimal separators. eBay renders 1.234,56 in some
  // locales and 1,234.56 in others; the last separator is always the decimal.
  let raw = m[1]
  const lastComma = raw.lastIndexOf(',')
  const lastDot = raw.lastIndexOf('.')
  if (lastComma > lastDot) raw = raw.replace(/\./g, '').replace(',', '.')
  else raw = raw.replace(/,/g, '')

  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return { cents: Math.round(n * 100), currency }
}

/** Back-compat helper used by direct unit tests. Prefer parsePrice. */
export function parsePriceCents (text) {
  const p = parsePrice(text)
  return p ? p.cents : null
}

export function parseSoldDate (text) {
  if (!text) return null
  const m = String(text).match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (month === undefined) return null
  return Date.UTC(Number(m[3]), month, Number(m[2]))
}

export function soldSearchUrl (query, { perPage = 240 } = {}) {
  const p = new URLSearchParams({ _nkw: query, LH_Sold: '1', LH_Complete: '1', _ipg: String(perPage) })
  return `https://www.ebay.com/sch/i.html?${p}`
}

function extractItemId (href) {
  const m = String(href || '').match(/\/itm\/(?:.*\/)?(\d{9,})/)
  return m ? m[1] : null
}

const PLACEHOLDER_RE = /^(shop on ebay|results matching fewer words|new listing)$/i

// Screen-reader text eBay appends inside the title anchor. Left in place it
// pollutes every comp title and leaks into the identity prompt.
const A11Y_NOISE_RE = /\s*Opens in a new window or tab\s*$/i

export function cleanTitle (raw) {
  return String(raw ?? '')
    .replace(A11Y_NOISE_RE, '')
    .replace(/^New Listing/i, '')
    .trim()
}

/**
 * Returns {strategy, comps, currency, currencies}.
 * `currency` is the dominant currency across the page. The caller is expected
 * to reject a page whose currency is not the configured one.
 */
export function parseSoldHtml (html) {
  const $ = cheerio.load(html)

  for (const s of SELECTOR_STRATEGIES) {
    const comps = []
    $(s.root).each((_, el) => {
      const node = $(el)
      const title = cleanTitle(node.find(s.title).first().text())
      const price = parsePrice(node.find(s.price).first().text())
      if (!title || PLACEHOLDER_RE.test(title) || !price) return
      const href = node.find(s.link).first().attr('href') ?? null
      const captionText = node.find(s.caption).map((_i, c) => $(c).text()).get().join(' ')
      comps.push({
        ebayItemId: extractItemId(href),
        title,
        priceCents: price.cents,
        currency: price.currency,
        soldAt: parseSoldDate(captionText),
        url: href,
        condition: null,
      })
    })

    // Deduplicate: eBay renders the same item in both a card and a hidden wrapper.
    const seen = new Set()
    const unique = comps.filter((c) => {
      const key = c.ebayItemId ?? `${c.title}|${c.priceCents}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (unique.length > 0) {
      const tally = {}
      for (const c of unique) if (c.currency) tally[c.currency] = (tally[c.currency] ?? 0) + 1
      const currencies = Object.keys(tally)
      const currency = currencies.sort((a, b) => tally[b] - tally[a])[0] ?? null
      return { strategy: s.name, comps: unique, currency, currencies }
    }
  }

  return { strategy: null, comps: [], currency: null, currencies: [] }
}

const SIGNIN_RE = /(sign in or register|security measure)/i

export function detectGate (html, title = '') {
  const probe = `${title} ${String(html).slice(0, 4000)}`
  if (SIGNIN_RE.test(probe)) {
    return {
      gated: true,
      reason: 'eBay requires a signed-in account to view sold listings. Run: fbay ebay-login',
    }
  }
  return { gated: false, reason: null }
}

export function createSoldClient ({
  fetchImpl = globalThis.fetch,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  async function fetchSold (query, opts = {}) {
    const url = soldSearchUrl(query, opts)
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      })
      if (res.ok) {
        const html = await res.text()
        const gate = detectGate(html)
        if (gate.gated) return { ok: false, error: gate.reason, gated: true, url }
        return { ok: true, ...parseSoldHtml(html), url }
      }
      lastError = `eBay sold fetch failed: ${res.status}`
      await sleepImpl(500 * 2 ** attempt)
    }
    return { ok: false, error: lastError, url }
  }
  return { fetchSold }
}
