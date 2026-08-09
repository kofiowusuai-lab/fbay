/**
 * Is a listing still live?
 *
 * An alert you cannot act on is worse than no alert: it costs the operator a
 * trip to their phone and teaches them to ignore the channel. By the time a
 * deal is sent, the listing has been through identification and two eBay
 * lookups, and may already have been hours old when scraped - so on a fast
 * category it can easily be gone.
 */
/**
 * Facebook words a dead listing differently per surface, so matching one string
 * is not enough: the mobile app shows "This listing no longer exists", while
 * the desktop web page shows "This page isn't available. The link may be
 * broken, or the page may have been removed." An earlier version only matched a
 * "Sorry, this page isn't available" variant that desktop never produces, so
 * removed listings sailed through as live and reached the operator's phone.
 *
 * Verified against a real removed-listing page, not assumed.
 */
const DEAD_MARKERS = [
  /this listing no longer exists/i,
  /this page isn'?t available/i,
  /the link may be broken/i,
  /the page may have been removed/i,
  /listing (is )?(no longer available|has been removed|not available)/i,
  /content (isn'?t|is not) available/i,
  /sorry, (something went wrong|this (page|content) isn'?t available)/i,
  /this ad has (expired|been removed)/i,
  /ad (not found|no longer available)/i,
  /page not found/i,
  /we couldn'?t find (the|that) (page|listing)/i,
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
