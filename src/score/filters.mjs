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
