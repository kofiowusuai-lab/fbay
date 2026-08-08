import { createHash } from 'node:crypto'

function sha (s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

/** Keyed on what the model would actually see. Changing the ask price must not bust it. */
export function contentHash (listing) {
  return sha([listing.title ?? '', listing.description ?? '', (listing.imageUrls ?? [])[0] ?? ''].join(' '))
}

/**
 * Keyed on the item itself, so two listings of the same phone share one CompSet.
 * Condition is part of the key because a for-parts unit is a different product.
 * modelYear is deliberately excluded: sellers get it wrong constantly and it
 * would fragment the cache without improving the comps.
 */
export function identityKeyFor (i) {
  const parts = [i.brand, i.model, i.variant, i.capacity, i.category, i.condition]
    .map((p) => String(p ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
  return sha(parts.join('|'))
}
