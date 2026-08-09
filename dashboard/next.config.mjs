import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default {
  // ~/fbay and ~/fbay/dashboard each have a lockfile, so Next guesses the
  // parent as the workspace root. Pin it.
  outputFileTracingRoot: here,
  serverExternalPackages: ['better-sqlite3'],
  images: { unoptimized: true },
}
