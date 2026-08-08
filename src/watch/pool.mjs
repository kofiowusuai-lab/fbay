/**
 * Run tasks with a bounded number in flight.
 *
 * Concurrency here is about the model, not the marketplace. Identification is
 * the bottleneck - roughly 20s per listing on the Codex provider because a whole
 * agent process starts each time - and those calls are independent, so running
 * them together turns a 4-listing scan from 80 seconds into about 20.
 *
 * Facebook request rate is deliberately NOT raised by this: the pacer is shared
 * across all workers, so its hourly ceiling and human-shaped delays still bound
 * what the marketplace sees. More throughput, same footprint.
 */
export async function mapPool (items, limit, fn) {
  const results = new Array(items.length)
  let next = 0

  async function worker () {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = { ok: true, value: await fn(items[i], i) }
      } catch (e) {
        // One failure must not reject the pool and strand its siblings.
        results[i] = { ok: false, error: e }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}
