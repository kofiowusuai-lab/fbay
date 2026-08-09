const ID_RE = /\/p\/[^/]+\/[^/]+\/(\d{6,})/
const PRICE_RE = /^£\s?([\d,]+(?:\.\d{1,2})?)$/

export function extractGumtreeId (href) {
  const m = String(href || '').match(ID_RE)
  return m ? m[1] : null
}

export function parsePriceCents (text) {
  const m = String(text ?? '').trim().match(PRICE_RE)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * A Gumtree card's innerText is a fixed shape: an image count, the title, a
 * description, the location, then the price. The count and price are both
 * numeric, so position matters - the price is identified by its £ prefix and
 * the location by being the line directly above it.
 *
 * Titles are taken as the first line that is not the leading image count,
 * because that count is a bare integer and would otherwise pass for a title.
 */
export function parseGumtreeCard (card, { now = Date.now() } = {}) {
  const id = extractGumtreeId(card.href)
  if (!id) return null

  const lines = (card.lines ?? []).map((l) => String(l).trim()).filter(Boolean)

  let priceIndex = -1
  let priceCents = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = parsePriceCents(lines[i])
    if (p !== null) { priceCents = p; priceIndex = i; break }
  }
  if (priceCents === null) return null

  // Drop the leading image-count line: a bare integer with no currency.
  const body = lines.slice(0, priceIndex).filter((l, i) => !(i === 0 && /^\d+$/.test(l)))
  const title = body[0]
  if (!title) return null

  return {
    source: 'gumtree',
    fbId: `gt:${id}`,
    title,
    description: body.length > 2 ? body[1] : null,
    priceCents,
    city: body.length > 1 ? body[body.length - 1] : null,
    imageUrls: card.img ? [card.img] : [],
    url: `https://www.gumtree.com${card.href}`,
    seenAt: now,
  }
}

export function parseGumtreeCards (cards, opts = {}) {
  const seen = new Set()
  const out = []
  for (const c of cards) {
    const l = parseGumtreeCard(c, opts)
    if (!l || seen.has(l.fbId)) continue
    seen.add(l.fbId)
    out.push(l)
  }
  return out
}

export function buildGumtreeUrl ({ query, city = 'london', distanceMiles = 30, maxPriceCents, minPriceCents }) {
  const p = new URLSearchParams({
    search_category: 'all',
    q: query,
    search_location: String(city).toLowerCase().replace(/\s+/g, '-'),
    distance: String(distanceMiles),
  })
  if (maxPriceCents != null) p.set('max_price', String(Math.floor(maxPriceCents / 100)))
  if (minPriceCents != null) p.set('min_price', String(Math.floor(minPriceCents / 100)))
  return `https://www.gumtree.com/search?${p}`
}

/** Runs in the page. Self-contained: no closures, no imports. */
export function EXTRACT_GUMTREE_FN () {
  return Array.from(document.querySelectorAll('[data-q="search-result"]')).map((el) => ({
    href: el.querySelector('a[href*="/p/"]')?.getAttribute('href') ?? '',
    lines: (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean),
    img: el.querySelector('img')?.src ?? null,
  }))
}
