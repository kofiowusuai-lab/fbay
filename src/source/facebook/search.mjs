export const SORT_OPTIONS = {
  default: 'creation_time_descend',
  newest: 'creation_time_descend',
  price_asc: 'price_ascend',
  price_desc: 'price_descend',
  distance: 'distance_ascend',
  best_match: 'best_match',
}

const VALID_SORTS = new Set(Object.values(SORT_OPTIONS))

export function citySlug (city) {
  return String(city).toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function buildSearchUrl ({ city, query, category, minPriceCents, maxPriceCents, radiusKm = 40, sort }) {
  if (!city) throw new Error('buildSearchUrl requires a city; a location-less search would burn the request budget')

  const slug = citySlug(city)
  const sortBy = VALID_SORTS.has(sort) ? sort : SORT_OPTIONS.default

  const params = new URLSearchParams()
  if (!category && query) params.set('query', query)
  if (minPriceCents != null) params.set('minPrice', String(Math.floor(minPriceCents / 100)))
  if (maxPriceCents != null) params.set('maxPrice', String(Math.floor(maxPriceCents / 100)))
  params.set('radius', String(radiusKm))
  params.set('sortBy', sortBy)
  params.set('exact', 'false')

  const path = category ? `${slug}/${category}` : `${slug}/search`
  return `https://www.facebook.com/marketplace/${path}?${params}`
}
