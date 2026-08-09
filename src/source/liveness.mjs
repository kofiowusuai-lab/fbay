/**
 * Is a listing still live?
 *
 * An alert you cannot act on is worse than no alert: it costs the operator a
 * trip to their phone and teaches them to ignore the channel. By the time a
 * deal is sent, the listing has been through identification and two eBay
 * lookups, and may already have been hours old when scraped - so on a fast
 * category it can easily be gone.
 */
const DEAD_MARKERS = [
  /this listing no longer exists/i,
  /listing (is )?(no longer available|has been removed|not available)/i,
  /content (isn'?t|is not) available/i,
  /sorry, this (page|content) isn'?t available/i,
  /this ad has (expired|been removed)/i,
  /ad not found/i,
  /page not found/i,
]

const SOLD_MARKERS = [
  /marked as sold/i,
  /^sold$/im,
  /this item has been sold/i,
]

export function classifyPage ({ bodyText = '', status = 200 }) {
  if (status === 404 || status === 410) return { live: false, reason: `http ${status}` }
  const probe = String(bodyText).slice(0, 4000)
  const dead = DEAD_MARKERS.find((re) => re.test(probe))
  if (dead) return { live: false, reason: 'listing removed' }
  const sold = SOLD_MARKERS.find((re) => re.test(probe))
  if (sold) return { live: false, reason: 'marked sold' }
  return { live: true, reason: null }
}

/**
 * Checks a listing with the session that scraped it. Returns live:true on any
 * error - a network blip must not suppress a real deal, because a false
 * negative here costs money while a false positive only costs one wasted tap.
 */
export async function verifyLive (url, session) {
  if (!session?.goto) return { live: true, checked: false }
  try {
    const nav = await session.goto(url, { waitMs: 1500, timeout: 20000 })
    if (nav.ok === false) return { live: true, checked: false, reason: nav.error }
    if (nav.block?.blocked) return { live: true, checked: false, reason: `blocked: ${nav.block.kind}` }
    const r = classifyPage({ bodyText: nav.bodyText, status: 200 })
    return { ...r, checked: true }
  } catch (e) {
    return { live: true, checked: false, reason: String(e.message ?? e).slice(0, 80) }
  }
}
