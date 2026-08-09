const ITEM_ID_RE = /\/marketplace\/item\/(\d+)/
const PRICE_RE = /^[^\d]{0,4}\$?\s?([\d,]+(?:\.\d{1,2})?)\s*$/
const FREE_RE = /^free$/i

// Chrome-injected UI text that is never a title.
const NOISE_RE = /^(just listed|new listing|sponsored|free shipping|shipping available|see more|save|share|listed \w+ ago|\d+ (miles?|km) away)$/i

export function extractFbId (href) {
  const m = String(href || '').match(ITEM_ID_RE)
  return m ? m[1] : null
}

export function parsePriceCents (text) {
  const s = String(text ?? '').trim()
  if (FREE_RE.test(s)) return 0
  const m = s.match(PRICE_RE)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * Facebook renders a listing card as an anchor containing, in order:
 * current price, optional strikethrough original price, title, location.
 * We take the FIRST price line as current, because a discounted card puts the
 * live price first and the crossed-out one second. Taking the max would value
 * every discounted listing at its pre-discount price.
 */
export function parseListingNode (node, { now = Date.now() } = {}) {
  const fbId = extractFbId(node.href)
  if (!fbId) return null

  const lines = (node.lines ?? []).map((l) => String(l).trim()).filter(Boolean)
  let priceCents = null
  let priceIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const p = parsePriceCents(lines[i])
    if (p !== null) { priceCents = p; priceIndex = i; break }
  }
  if (priceCents === null) return null

  const rest = lines
    .slice(priceIndex + 1)
    .filter((l) => parsePriceCents(l) === null && !NOISE_RE.test(l))

  const title = rest[0] ?? null
  if (!title) return null
  const city = rest.length > 1 ? rest[rest.length - 1] : null

  return {
    fbId,
    title,
    priceCents,
    city,
    imageUrls: node.image ? [node.image] : [],
    url: `https://www.facebook.com/marketplace/item/${fbId}/`,
    seenAt: now,
  }
}

export function parseListingNodes (nodes, opts = {}) {
  const seen = new Set()
  const out = []
  for (const n of nodes) {
    const l = parseListingNode(n, opts)
    if (!l || seen.has(l.fbId)) continue
    seen.add(l.fbId)
    out.push(l)
  }
  return out
}

/**
 * Reject listings outside the operator's country.
 *
 * Facebook's Marketplace location is account state, not a URL parameter: the
 * /marketplace/<city>/ path SETS it and it persists across later requests. So a
 * session whose account was last pointed at another country happily serves
 * foreign listings for a UK city slug - observed live, returning Bogota results
 * for a London search. The URL is a request, not a guarantee, so the country is
 * checked on every listing.
 *
 * Facebook renders a domestic listing as a bare town ("Loughton") or
 * "Town, Country", and a foreign one always with its country. So the test is
 * the trailing country segment, not the town, which is why a whitelist of towns
 * would be both endless and wrong.
 */
export const HOME_COUNTRY_PATTERNS = {
  GB: /^(united kingdom|uk|england|scotland|wales|northern ireland)$/i,
  US: /^(united states|usa|us)$/i,
}

/**
 * Countries seen in the wild on Marketplace listings. The trailing segment of a
 * location is only treated as a country when it actually looks like one.
 *
 * The first version tested "is the trailing segment my country?" and rejected
 * everything else. That works for Facebook, which writes "Town, Country", and
 * silently binned every Gumtree listing, which writes "Area, City" - "Putney,
 * London" was read as being in a country called London. Rejecting a whole
 * marketplace is a far worse failure than letting an unrecognised location
 * through, so the default is now to accept.
 */
const FOREIGN_COUNTRY_RE = /^(colombia|spain|españa|france|germany|deutschland|italy|italia|portugal|poland|polska|romania|netherlands|belgium|ireland|mexico|m[ée]xico|brazil|brasil|argentina|chile|peru|per[uú]|united states|usa|canada|australia|india|pakistan|nigeria|ghana|kenya|south africa|turkey|t[uü]rkiye|greece|sweden|norway|denmark|finland|austria|switzerland|czechia|hungary|bulgaria|croatia|morocco|egypt|uae|united arab emirates|philippines|indonesia|malaysia|thailand|vietnam|china|japan|korea)$/i

export function listingCountry (city) {
  if (!city) return null
  const parts = String(city).split(',').map((p) => p.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : null
}

export function isDomestic (city, country = 'GB') {
  const tail = listingCountry(city)
  if (!tail) return true // a bare town name is local by construction

  const home = HOME_COUNTRY_PATTERNS[country]
  if (home?.test(tail)) return true

  // Only reject when the tail is recognisably a DIFFERENT country. A county or
  // city ("Putney, London", "Aveley, Essex") is not a country and is local.
  return !FOREIGN_COUNTRY_RE.test(tail)
}
