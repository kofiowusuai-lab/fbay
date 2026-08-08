export const DRAFT_SYSTEM = `You write short messages to Facebook Marketplace sellers as an ordinary local buyer.

Rules:
- Two sentences maximum. Marketplace sellers ignore paragraphs.
- Open by confirming availability, then make the offer as a specific number.
- Give one plain, human reason for the number: cash today, can collect this evening, saw similar ones around that price. One reason, not three.
- Sound like a person texting, not a business. No greetings like "Dear", no sign-off, no exclamation marks.
- Never mention resale, reselling, eBay, flipping, profit, or that you value the item higher than they do. That kills the deal instantly.
- Never claim a fault you have not seen. Do not invent damage as a negotiating lever.
- Output only the message text. No quotes around it, no preamble, no explanation.`

/** Round down to a clean $5 increment. Odd numbers read as calculated and invite haggling. */
function roundToFive (cents) {
  return Math.floor(cents / 500) * 500
}

/**
 * Order matters. The minFraction floor stops us insulting a seller with an
 * absurd lowball, but it must never lift the offer above breakeven: that would
 * mean offering more than the item is worth to us. So the floor is applied to
 * the desired offer, and breakeven caps the result absolutely.
 */
export function offerPriceCents ({ askCents, breakevenBuyCents, discount = 0.2, minFraction = 0.6 }) {
  const target = askCents * (1 - discount)
  const floor = askCents * minFraction
  const desired = Math.max(target, floor)
  const capped = Math.min(desired, breakevenBuyCents ?? desired)
  return Math.max(roundToFive(capped), 100)
}

export function buildDraftPrompt ({ listing, identity, offerCents }) {
  const d = (c) => `$${Math.round(c / 100)}`
  return [
    `Item: ${[identity.brand, identity.model].filter(Boolean).join(' ') || listing.title}`,
    `Listing title: ${listing.title}`,
    `They are asking: ${d(listing.priceCents)}`,
    `Offer this amount: ${d(offerCents)}`,
    listing.city ? `Location: ${listing.city}` : null,
    '',
    'Write the message.',
  ].filter(Boolean).join('\n')
}

function stripQuotes (s) {
  return String(s).trim().replace(/^["'`]+|["'`]+$/g, '').trim()
}

export async function draftOffer ({ listing, identity, profit, llm, discount = 0.2 }) {
  const offerCents = offerPriceCents({
    askCents: listing.priceCents,
    breakevenBuyCents: profit.breakevenBuyCents,
    discount,
  })

  const res = await llm.completeText({
    system: DRAFT_SYSTEM,
    user: buildDraftPrompt({ listing, identity, offerCents }),
    maxTokens: 200,
  })

  if (!res.ok) {
    return {
      ok: true,
      fallback: true,
      offerCents,
      body: `Hi, is this still available? I could do $${Math.round(offerCents / 100)} cash and collect today if that works.`,
    }
  }

  return { ok: true, fallback: false, offerCents, body: stripQuotes(res.text) }
}
