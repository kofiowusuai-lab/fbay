export class PaceLimitError extends Error {
  constructor (message, kind) {
    super(message)
    this.name = 'PaceLimitError'
    this.kind = kind
  }
}

const HOUR_MS = 3600000
const BASE_COOLDOWN_MS = 15 * 60000

export function createPacer ({
  config,
  clock = Date.now,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  rng = Math.random,
}) {
  let requestTimes = []
  let listingsCounted = 0
  let lastRequestAt = null
  let blockCount = 0
  let cooldownUntil = 0

  function pruneWindow () {
    const cutoff = clock() - HOUR_MS
    requestTimes = requestTimes.filter((t) => t > cutoff)
  }

  function cooldownMs () {
    return BASE_COOLDOWN_MS * 2 ** Math.max(0, blockCount - 1)
  }

  /**
   * Skewed toward the short end so the traffic looks like scrolling rather than
   * a metronome, but with a long tail so the pattern is not periodic.
   */
  function nextDelayMs (r = rng()) {
    const { minDelayMs, maxDelayMs } = config
    const skewed = r ** 1.7
    return Math.round(minDelayMs + skewed * (maxDelayMs - minDelayMs))
  }

  return {
    nextDelayMs,

    async beforeRequest () {
      if (clock() < cooldownUntil) {
        throw new PaceLimitError(`cooling down for ${Math.ceil((cooldownUntil - clock()) / 1000)}s after a block`, 'cooldown')
      }
      pruneWindow()
      if (requestTimes.length >= config.maxRequestsPerHour) {
        throw new PaceLimitError(`hourly request ceiling of ${config.maxRequestsPerHour} reached`, 'hourly')
      }
      if (lastRequestAt !== null) await sleepImpl(nextDelayMs())
      lastRequestAt = clock()
      requestTimes.push(lastRequestAt)
    },

    countListings (n) { listingsCounted += n },
    listingBudgetRemaining () { return Math.max(0, config.maxListingsPerDay - listingsCounted) },
    listingBudgetExhausted () { return listingsCounted >= config.maxListingsPerDay },

    shouldFetchDetail (r = rng()) { return r < config.detailFetchRatio },

    recordBlock (kind) {
      blockCount += 1
      cooldownUntil = clock() + cooldownMs()
      return { kind, blockCount, cooldownUntil }
    },

    clearBlocks () { blockCount = 0; cooldownUntil = 0 },
    isCoolingDown () { return clock() < cooldownUntil },

    stats () {
      pruneWindow()
      return {
        requestsThisHour: requestTimes.length,
        listingsCounted,
        listingBudgetRemaining: Math.max(0, config.maxListingsPerDay - listingsCounted),
        blockCount,
        cooldownUntil,
        cooldownMs: cooldownMs(),
      }
    },
  }
}
