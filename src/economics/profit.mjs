import { computeFees } from './fees.mjs'
import { shippingFor } from './shipping.mjs'

/**
 * All money in integer cents. Returns null for net/breakeven on freight items
 * because a parcel estimate would be a lie, and a lie here loses real money.
 */
export function computeProfit ({ grossCents, askCents, category, config, weightLb, localResale = false }) {
  const { promotedRate, bufferRate, sellerType } = config.economics
  const marketplace = config.marketplace ?? 'EBAY_US'
  const fees = computeFees({ grossCents, category, promotedRate, marketplace, sellerType })
  const ship = shippingFor({ category, weightLb, localResale, marketplace })
  const bufferCents = Math.round(grossCents * bufferRate)

  const base = {
    grossCents,
    askCents,
    category,
    rate: fees.rate,
    feeRegime: fees.regime,
    fvfCents: fees.fvfCents,
    perOrderCents: fees.perOrderCents,
    promotedCents: fees.promotedCents,
    bufferCents,
    shippingCents: ship.costCents,
    weightLb: ship.weightLb,
    weightKg: ship.weightKg ?? null,
    shippingBand: ship.band.key,
    freight: ship.freight,
    localResale: ship.localResale,
  }

  if (ship.freight) {
    return { ...base, breakevenBuyCents: null, netCents: null, roi: null, margin: null }
  }

  const breakevenBuyCents =
    grossCents - fees.fvfCents - fees.perOrderCents - ship.costCents - fees.promotedCents - bufferCents
  const netCents = breakevenBuyCents - askCents

  return {
    ...base,
    breakevenBuyCents,
    netCents,
    roi: askCents > 0 ? netCents / askCents : null,
    margin: grossCents > 0 ? netCents / grossCents : null,
  }
}
