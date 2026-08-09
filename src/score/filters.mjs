import { isDomestic } from '../source/facebook/parse.mjs'

/**
 * Title-only rejections that need no model call and no eBay lookup. Running
 * these first is what keeps a bounded scan from spending its whole budget on
 * "(BOX ONLY)" listings - identification and comps are the expensive steps, and
 * a blacklisted title was never going to survive them.
 */
export function prefilter (listing, config) {
  const country = config.location?.country
  if (country && !isDomestic(listing.city, country)) {
    return { rejected: true, rule: 'foreign_listing', reason: `listing is in ${listing.city}, outside ${country}` }
  }

  const title = String(listing.title ?? '').toLowerCase()
  const kw = (config.blacklist?.keywords ?? []).find((k) => title.includes(k.toLowerCase()))
  if (kw) return { rejected: true, rule: 'blacklist_keyword', reason: `title contains blacklisted keyword "${kw}"` }

  if (listing.priceCents > config.thresholds.maxAskCents) {
    return { rejected: true, rule: 'max_ask', reason: `ask above the ${config.thresholds.maxAskCents / 100} ceiling` }
  }
  return { rejected: false }
}

function money (cents) {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Every rule returns null to pass, or {rule, reason} to reject.
 * All rules run. Returning every reason is the point: `fbay deals --rejected`
 * has to explain exactly why anything was dropped.
 */
export function applyFilters ({ listing, identity, compset, profit }, config) {
  const t = config.thresholds
  const rejections = []

  if (profit.freight && !config.freight.enabled) {
    rejections.push({ rule: 'freight_disabled', reason: 'freight-class item and freight is disabled in config' })
  }

  if (!profit.freight) {
    if (profit.netCents == null || profit.netCents < t.minNetProfitCents) {
      rejections.push({ rule: 'min_net_profit', reason: `net ${money(profit.netCents ?? 0)} below floor ${money(t.minNetProfitCents)}` })
    }
    if (profit.roi != null && profit.roi < t.minRoi) {
      rejections.push({ rule: 'min_roi', reason: `roi ${profit.roi.toFixed(2)} below floor ${t.minRoi}` })
    }
  }

  if (compset.sellThrough == null) {
    rejections.push({
      rule: 'sell_through_unavailable',
      reason: 'sell-through could not be computed (eBay active-listing count unavailable) - refusing to treat an unknown as a pass',
    })
  } else if (compset.sellThrough < t.minSellThrough) {
    rejections.push({ rule: 'min_sell_through', reason: `sell-through ${(compset.sellThrough * 100).toFixed(0)}% below floor ${(t.minSellThrough * 100).toFixed(0)}%` })
  }

  if (compset.sampleN < t.minCompSampleSize) {
    rejections.push({ rule: 'min_comp_sample', reason: `only ${compset.sampleN} usable comps, need ${t.minCompSampleSize}` })
  }

  if (identity.identityConfidence < t.minIdentityConfidence) {
    rejections.push({ rule: 'min_identity_confidence', reason: `identity confidence ${identity.identityConfidence} below floor ${t.minIdentityConfidence}` })
  }

  if (listing.priceCents > t.maxAskCents) {
    rejections.push({ rule: 'max_ask', reason: `ask ${money(listing.priceCents)} above ceiling ${money(t.maxAskCents)}` })
  }

  const title = String(listing.title).toLowerCase()
  const kw = (config.blacklist?.keywords ?? []).find((k) => title.includes(k.toLowerCase()))
  if (kw) rejections.push({ rule: 'blacklist_keyword', reason: `title contains blacklisted keyword "${kw}"` })

  const seller = listing.sellerName
  if (seller && (config.blacklist?.sellers ?? []).some((s) => s.toLowerCase() === seller.toLowerCase())) {
    rejections.push({ rule: 'blacklist_seller', reason: `seller "${seller}" is blacklisted` })
  }

  return { passed: rejections.length === 0, rejections }
}

/**
 * A near miss failed exactly one rule while still showing a real profit.
 *
 * Silence is not the same as safety. A monitor that only ever speaks on a
 * perfect deal leaves the operator unable to tell "the market is thin" from
 * "the thresholds are wrong" from "the scraper broke", so borderline finds are
 * surfaced too - labelled, with the one reason they failed, and never as a buy
 * recommendation.
 */
/**
 * A near miss must be NEAR. Counting failed rules is not enough.
 *
 * The first version asked only "did exactly one check fail, and is there
 * profit". That sent a Nintendo Switch with 6% sell-through against a 35%
 * floor - 665 listed against 43 sold - described as a near miss. It failed one
 * rule by a factor of six. Marginal alerts are also the ones most likely to be
 * stale by the time the operator looks at them, so noise here costs twice.
 *
 * The failed value must now reach a proportion of its floor to qualify.
 */
export const NEAR_MISS_TOLERANCE = 0.7

export function isNearMiss ({ rejections, profit, compset }, config = {}) {
  const { minNetProfitCents = 0, tolerance = NEAR_MISS_TOLERANCE } = config
  if (!rejections || rejections.length !== 1) return false
  if (profit?.netCents == null || profit.netCents < minNetProfitCents) return false

  const rule = rejections[0].rule
  // A hard no is never softened into a near miss.
  if (['blacklist_keyword', 'blacklist_seller', 'max_ask', 'freight_disabled', 'foreign_listing'].includes(rule)) return false

  const t = config.thresholds ?? {}
  const closeEnough = (actual, floor) =>
    actual != null && floor != null && floor > 0 && actual >= floor * tolerance

  switch (rule) {
    case 'min_sell_through':
      return closeEnough(compset?.sellThrough, t.minSellThrough)
    case 'min_roi':
      return closeEnough(profit?.roi, t.minRoi)
    case 'min_net_profit':
      return closeEnough(profit?.netCents, t.minNetProfitCents)
    case 'min_comp_sample':
      return closeEnough(compset?.sampleN, t.minCompSampleSize)
    case 'sell_through_unavailable':
      // Unknown is not near anything; it is unknown.
      return false
    default:
      // An unrecognised rule (e.g. identity confidence) still counts, since
      // there is no floor to measure closeness against.
      return true
  }
}
