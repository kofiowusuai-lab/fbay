export function isQuietHour (hour, { start, end }) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
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
}) {
  while (shouldContinue()) {
    const now = clock()
    const hour = new Date(now).getHours()

    if (isQuietHour(hour, config.quietHours)) {
      logger.log(`quiet hours (${hour}:00), sleeping`)
      await sleepImpl(jitterMs(tickMs))
      continue
    }

    const due = dueWatches(repo.listWatches(), now)
    if (!due.length) {
      await sleepImpl(jitterMs(tickMs))
      continue
    }

    for (const watch of due) {
      // One watch failing must not end the loop - the next watch, and the next
      // pass, may be perfectly healthy.
      let r
      try {
        r = await runOne(watch)
      } catch (e) {
        r = { ok: false, error: `unhandled: ${String(e.message ?? e).split('\n')[0].slice(0, 140)}` }
      }
      logger.log(`[${watch.name}] ${r.ok ? `${r.listingsSeen} seen, ${r.listingsNew} new, ${r.dealsFound} deals` : `failed: ${r.error}`}`)
      if (!r.ok && r.kind) {
        await notifier.notifyAlert(`scan halted on watch "${watch.name}": ${r.error}`)
        break
      }
    }

    await sleepImpl(jitterMs(tickMs))
  }
}
