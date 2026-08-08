const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
const SCOPE = 'https://api.ebay.com/oauth/api_scope'

export function toCents (value) {
  if (value == null) return null
  const n = Number(String(value).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function parseBrowseResponse (body) {
  const items = (body.itemSummaries ?? [])
    .map((it) => ({
      ebayItemId: it.itemId,
      title: it.title,
      priceCents: toCents(it.price?.value),
      condition: it.condition ?? null,
      url: it.itemWebUrl ?? null,
    }))
    .filter((it) => it.title && it.priceCents != null)
  return { total: body.total ?? items.length, items }
}

export function createBrowseClient ({
  appId,
  certId,
  marketplace = 'EBAY_US',
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let token = null
  let tokenExpiresAt = 0

  async function getToken () {
    if (!appId || !certId) return { ok: false, error: 'EBAY_APP_ID / EBAY_CERT_ID not set' }
    if (token && clock() < tokenExpiresAt) return { ok: true, token }
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${appId}:${certId}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    })
    if (!res.ok) return { ok: false, error: `eBay token request failed: ${res.status}` }
    const body = await res.json()
    token = body.access_token
    // Refresh 60s early so a request never races the expiry boundary.
    tokenExpiresAt = clock() + (body.expires_in - 60) * 1000
    return { ok: true, token }
  }

  async function searchActive (query, { limit = 200, categoryId, filter } = {}) {
    const t = await getToken()
    if (!t.ok) return t

    const params = new URLSearchParams({ q: query, limit: String(Math.min(limit, 200)) })
    if (categoryId) params.set('category_ids', categoryId)
    if (filter) params.set('filter', filter)

    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetchImpl(`${SEARCH_URL}?${params}`, {
        headers: {
          Authorization: `Bearer ${t.token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplace,
          Accept: 'application/json',
        },
      })
      if (res.ok) return { ok: true, ...parseBrowseResponse(await res.json()) }
      lastError = `eBay Browse search failed: ${res.status}`
      if (res.status < 500) break
      await sleepImpl(300 * 2 ** attempt)
    }
    return { ok: false, error: lastError }
  }

  return { getToken, searchActive }
}
