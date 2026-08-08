const REL_TIME_RE = /listed\s+(a|an|\d+)\s*(minute|hour|day|week|month)s?\s+ago/i
const UNIT_MS = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 }

const SELLER_MARKER_RE = /^(seller information|about the seller|listed by)$/i
const DESC_MARKER_RE = /^(description|details)$/i
const CONDITION_RE = /^condition:\s*(.+)$/i

export function parseListedAt (text, now = Date.now()) {
  const m = String(text ?? '').match(REL_TIME_RE)
  if (!m) return null
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1
  return now - n * UNIT_MS[m[2].toLowerCase()]
}

function detectDelivery (lines) {
  const joined = lines.join(' ').toLowerCase()
  if (/shipping and local pickup/.test(joined)) return 'both'
  const pickup = /local pickup|pickup only|meet up/.test(joined)
  const shipping = /shipping available|ships from/.test(joined)
  if (pickup && shipping) return 'both'
  if (shipping) return 'shipping'
  if (pickup) return 'pickup'
  return null
}

export function parseDetail ({ bodyLines = [], imageUrls = [], now = Date.now() }) {
  const listedLine = bodyLines.find((l) => REL_TIME_RE.test(l))
  const conditionLine = bodyLines.find((l) => CONDITION_RE.test(l))

  let description = null
  const descIdx = bodyLines.findIndex((l) => DESC_MARKER_RE.test(l))
  if (descIdx !== -1) {
    const tail = []
    for (let i = descIdx + 1; i < bodyLines.length; i++) {
      if (SELLER_MARKER_RE.test(bodyLines[i])) break
      tail.push(bodyLines[i])
    }
    if (tail.length) description = tail.join('\n')
  }

  let sellerName = null
  const sellerIdx = bodyLines.findIndex((l) => SELLER_MARKER_RE.test(l))
  if (sellerIdx !== -1 && bodyLines[sellerIdx + 1]) sellerName = bodyLines[sellerIdx + 1]

  return {
    description,
    sellerName,
    condition: conditionLine ? conditionLine.match(CONDITION_RE)[1].trim() : null,
    listedAt: listedLine ? parseListedAt(listedLine, now) : null,
    delivery: detectDelivery(bodyLines),
    imageUrls,
  }
}
