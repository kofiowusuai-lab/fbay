import { mapPool } from './pool.mjs'

export function isQuietHour (hour, { start, end }) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/**
 * Milliseconds until quiet hours end. Polling every five minutes to re-discover
 * a wake time that is already known wastes wakeups and buries the log under
 * identical lines - by morning the only thing in it is a hundred repetitions of
 * "sleeping", which hides anything that actually happened.
 */
export function msUntilQuietEnds (now, { start, end }) {
  if (start === end) return 0
  const d = new Date(now)
  const wake = new Date(d)
  wake.setHours(end, 0, 0, 0)
  if (wake <= d) wake.setDate(wake.getDate() + 1)
  return wake.getTime() - now
}

export function jitterMs (baseMs, fraction = 0.25, rng = Math.random) {
  return Math.round(baseMs * (1 + (rng() * 2 - 1) * fraction))
}

/** Shuffled so a watcher on the other side cannot fingerprint a fixed rotation. */
export function dueWatches (watches, now, rng = Math.random) {
  const due = watches.filter((w) => {
    if (!w.enabled) return false
    if (!w.last_run_at) return true
    return now - w.last_run_at >= w.interval_minutes * 60000
  })
  return due
    .map((w) => ({ w, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.w)
}

export async function runLoop ({
  repo, config, notifier, runOne,
  clock = Date.now,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  tickMs = 5 * 60000,
  shouldContinue = () => true,
  logger = console,
  watchConcurrency = 1,
}) {
  let quietAnnounced = false
  while (shouldContinue()) {
    const now = clock()
    const hour = new Date(now).getHours()

    if (isQuietHour(hour, config.quietHours)) {
      const untilWake = msUntilQuietEnds(now, config.quietHours)
      if (!quietAnnounced) {
        const hrs = (untilWake / 3600000).toFixed(1)
        logger.log(`quiet hours until ${String(config.quietHours.end).padStart(2, '0')}:00 - sleeping ${hrs}h`)
        quietAnnounced = true
      }
      // Sleep to the wake time rather than polling, but cap each sleep so an
      // interrupt or a config change is still noticed within the hour.
      await sleepImpl(Math.min(untilWake + 1000, 3600000))
      continue
    }
    quietAnnounced = false

    const due = dueWatches(repo.listWatches(), now)
    if (!due.length) {
      await sleepImpl(jitterMs(tickMs))
      continue
    }

    // Watches run concurrently, each on its own browser page. The pacer is
    // shared, so this raises throughput without raising the request rate
    // Facebook sees - which is the constraint that actually matters.
    const outcomes = await mapPool(due, watchConcurrency, async (watch) => {
      // One watch failing must not end the loop - the next watch, and the next
      // pass, may be perfectly healthy.
      let r
      try {
        r = await runOne(watch)
      } catch (e) {
        r = { ok: false, error: `unhandled: ${String(e.message ?? e).split('\n')[0].slice(0, 140)}` }
      }
      logger.log(`[${watch.name}] ${r.ok ? `${r.listingsSeen} seen, ${r.listingsNew} new, ${r.dealsFound} deals` : `failed: ${r.error}`}`)
      return { watch, r }
    })

    // A block is account-level, not watch-level: if one scan was blocked the
    // others are running into the same wall, so surface it once and stop.
    const blocked = outcomes.map((o) => o.value).find((v) => v && !v.r.ok && v.r.kind)
    if (blocked) {
      await notifier.notifyAlert(`scan halted on "${blocked.watch.name}": ${blocked.r.error}`, { level: 'critical' })
    }

    await sleepImpl(jitterMs(tickMs))
  }
}
