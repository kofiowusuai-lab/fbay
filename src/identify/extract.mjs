import { MODELS } from '../llm.mjs'
import { contentHash, identityKeyFor } from './cache.mjs'

export const CATEGORIES = [
  'phone', 'tablet', 'laptop', 'camera', 'audio', 'gaming_console', 'gaming_accessory',
  'tv', 'tools', 'appliance', 'furniture', 'bicycle', 'exercise_equipment', 'clothing',
  'athletic_shoes', 'jewelry', 'watches', 'books_movies_music', 'musical_instrument',
  'trading_cards', 'heavy_equipment', 'toys', 'baby', 'sporting_goods', 'other',
]

export const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'for_parts']

export const IDENTITY_SCHEMA = {
  type: 'object',
  properties: {
    brand: { type: 'string', description: 'Manufacturer. Empty string if genuinely unknown.' },
    model: { type: 'string', description: 'Model name or number as a reseller would search for it.' },
    variant: { type: 'string', description: 'Size, trim or sub-model. Empty string if none.' },
    capacity: { type: 'string', description: 'Storage or capacity, e.g. 256GB. Empty string if not applicable.' },
    modelYear: { type: 'integer', description: 'Model year if determinable, otherwise 0.' },
    category: { type: 'string', enum: CATEGORIES },
    condition: { type: 'string', enum: CONDITIONS },
    identityConfidence: { type: 'number', description: '0 to 1. How certain you are this is the exact item.' },
    query: { type: 'string', description: 'The eBay search string a reseller would type to find sold comps.' },
    mustTokens: {
      type: 'array',
      items: { type: 'string' },
      description: 'Lowercase tokens a comparable sold listing MUST contain. Include the model number and any capacity that changes value. Do not include generic words.',
    },
    weightLb: { type: 'number', description: 'Estimated shipping weight in pounds including packaging. 0 if unknown.' },
  },
  required: ['brand', 'model', 'category', 'condition', 'identityConfidence', 'query', 'mustTokens'],
}

export const SYSTEM_PROMPT = `You identify second-hand items for resale arbitrage.

You are given a Facebook Marketplace listing: a sloppy title, an optional description, and photos. Your job is to work out exactly what the item is, precisely enough that a search of eBay sold listings returns comparable units and nothing else.

Rules:
- Photos outrank text. Sellers write "MacBook" for a 2015 Pro and a 2023 Air alike. Read the photos for the actual model, port layout, screen size, and physical damage.
- Condition drives value more than anything else. A cracked screen, missing parts, or heavy wear means fair or for_parts, not good. If the photos show damage the text does not mention, trust the photos.
- mustTokens is a filter, not a description. Include only tokens that a wrong-model listing would fail: the model number, the capacity when it changes price, the generation. Never include generic words like "used", "great", "working", or the brand alone.
- query is what a reseller types into eBay. Brand, model, key spec. No adjectives, no condition words.
- identityConfidence is honest. If the photos are dark, the item is partly out of frame, or the model could be one of several, say so with a low number. A confident wrong answer costs real money.
- If you truly cannot tell what it is, set category "other" and identityConfidence below 0.3.`

export function buildUserPrompt (listing) {
  const price = `$${((listing.priceCents ?? 0) / 100).toFixed(0)}`
  return [
    `Title: ${listing.title ?? '(none)'}`,
    `Description: ${listing.description ?? '(none)'}`,
    `Seller is asking: ${price}`,
    listing.condition ? `Seller-stated condition: ${listing.condition}` : null,
    '',
    'Identify this item.',
  ].filter(Boolean).join('\n')
}

/**
 * Keep at most MAX_MUST_TOKENS, preferring the discriminating ones.
 *
 * Models happily return eight tokens ("Apple", "MacBook Pro", "16-inch",
 * "2019", "i7", "16GB", "512GB", "Space Gray"). Every one is a hard AND against
 * comp titles, and real listings never contain all eight - so the comp set
 * empties out and the item cannot be valued. Tokens containing a digit (model
 * numbers, capacities, generations) do the actual discriminating; brand and
 * colour words do not.
 */
export const MAX_MUST_TOKENS = 4

export function pickMustTokens (raw) {
  const all = (raw ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean)
  const withDigits = all.filter((t) => /\d/.test(t))
  const without = all.filter((t) => !/\d/.test(t))
  return [...withDigits, ...without].slice(0, MAX_MUST_TOKENS)
}

export function normaliseIdentity (raw) {
  const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0))
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'other'
  const condition = CONDITIONS.includes(raw.condition) ? raw.condition : 'good'
  const identity = {
    brand: raw.brand || null,
    model: raw.model || null,
    variant: raw.variant || null,
    capacity: raw.capacity || null,
    modelYear: raw.modelYear && raw.modelYear > 1900 ? raw.modelYear : null,
    category,
    condition,
    identityConfidence: clamp(raw.identityConfidence),
    query: String(raw.query || '').trim(),
    mustTokens: pickMustTokens(raw.mustTokens),
    weightLb: raw.weightLb && raw.weightLb > 0 ? raw.weightLb : null,
  }
  identity.identityKey = identityKeyFor(identity)
  return identity
}

function rowToIdentity (row) {
  return {
    identityKey: row.identity_key,
    brand: row.brand,
    model: row.model,
    variant: row.variant,
    capacity: row.capacity,
    modelYear: row.model_year,
    category: row.category,
    condition: row.condition,
    identityConfidence: row.identity_confidence,
    query: row.query,
    mustTokens: JSON.parse(row.must_tokens),
    weightLb: row.weight_lb,
  }
}

/** Returns null on any failure: a missing photo degrades quality, it does not stop the pipeline. */
export async function defaultImageFetcher (url, { fetchImpl = globalThis.fetch, maxBytes = 4_000_000 } = {}) {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) return null
    const mediaType = res.headers?.get?.('content-type')?.split(';')[0] ?? 'image/jpeg'
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) return null
    return { mediaType, base64: buf.toString('base64') }
  } catch {
    return null
  }
}

export async function identify ({
  listing,
  repo,
  llm,
  config,
  imageFetcher = defaultImageFetcher,
  maxImages = 3,
  now = Date.now(),
}) {
  const hash = contentHash(listing)
  const cached = repo.getIdentityByContentHash(hash)
  if (cached) return { ok: true, cached: true, escalated: false, identity: rowToIdentity(cached) }

  const images = []
  for (const url of (listing.imageUrls ?? []).slice(0, maxImages)) {
    const img = await imageFetcher(url)
    if (img) images.push(img)
  }

  const request = {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(listing),
    schema: IDENTITY_SCHEMA,
    images,
    model: MODELS.fast,
  }

  let res = await llm.extractStructured(request)
  if (!res.ok) return { ok: false, error: res.error }

  let identity = normaliseIdentity(res.data)
  let escalated = false

  // One escalation only. A second uncertain answer means the photos are the
  // problem, and burning Opus tokens on it will not change that.
  if (identity.identityConfidence < config.thresholds.minIdentityConfidence) {
    const smart = await llm.extractStructured({ ...request, model: MODELS.smart })
    if (smart.ok) {
      escalated = true
      res = smart
      identity = normaliseIdentity(smart.data)
    }
  }

  repo.saveIdentity({ ...identity, contentHash: hash, modelUsed: res.model, createdAt: now })
  return { ok: true, cached: false, escalated, identity, usage: res.usage }
}
