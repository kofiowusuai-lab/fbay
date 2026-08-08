import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * stdin MUST be closed. `codex exec` reads instructions from stdin when it is
 * open, so a child spawned with an inherited or piped stdin waits forever for
 * input that never arrives - it hangs until the timeout rather than answering.
 * This does not reproduce when running codex by hand, because a terminal gives
 * it a TTY it knows not to read.
 */
export function runCodex (bin, args, { cwd, timeoutMs, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; resolve(r) } }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, error: `timed out after ${timeoutMs / 1000}s` })
    }, timeoutMs)

    child.stderr?.on('data', (d) => { stderr += d.toString().slice(0, 2000) })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}: ${stderr.slice(0, 200)}` })
    })
  })
}

export const CODEX_BIN = process.env.FBAY_CODEX_BIN || 'codex'

/**
 * Codex has no json_schema mode, so the schema is described in the prompt and
 * the reply is validated here. Models wrap JSON in code fences often enough
 * that stripping them is required, not defensive.
 */
export function extractJson (text) {
  if (!text) return { ok: false, error: 'empty response' }
  let s = String(text).trim()

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) s = fenced[1].trim()

  // Fall back to the outermost brace pair if the model added prose around it.
  if (!s.startsWith('{')) {
    const first = s.indexOf('{')
    const last = s.lastIndexOf('}')
    if (first === -1 || last <= first) return { ok: false, error: 'no JSON object in response' }
    s = s.slice(first, last + 1)
  }

  try { return { ok: true, data: JSON.parse(s) } } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` } }
}

/** Turn a JSON Schema into the literal shape instruction Codex responds to. */
export function schemaToPrompt (schema) {
  const lines = []
  for (const [k, v] of Object.entries(schema?.properties ?? {})) {
    const type = v.enum ? v.enum.map((e) => JSON.stringify(e)).join('|')
      : v.type === 'array' ? `${v.items?.type ?? 'string'}[]`
      : v.type
    lines.push(`  "${k}": ${type}${v.description ? `   // ${v.description}` : ''}`)
  }
  return `Reply with ONLY a JSON object, no prose and no code fences, with exactly these keys:\n{\n${lines.join('\n')}\n}`
}

export function isAvailable ({ homedir = os.homedir(), fsImpl = fs } = {}) {
  try {
    const auth = JSON.parse(fsImpl.readFileSync(path.join(homedir, '.codex', 'auth.json'), 'utf8'))
    if (auth.tokens) return { ok: true, mode: 'subscription', detail: 'codex: ChatGPT subscription (no API credits used)' }
    if (auth.OPENAI_API_KEY) return { ok: true, mode: 'api_key', detail: 'codex: api key' }
    return { ok: false, detail: 'codex installed but not authenticated - run: codex login' }
  } catch {
    return { ok: false, detail: 'codex not authenticated (~/.codex/auth.json missing) - run: codex login' }
  }
}

/**
 * Drives the Codex CLI as a vision backend. Satisfies the same interface as the
 * Anthropic and OpenAI clients, so nothing else in the codebase changes.
 *
 * Trade-offs against a direct API call, both real:
 *  - Latency is roughly 10-15s per call vs 2-3s, because a whole agent process
 *    starts each time. Fine for ad-hoc `fbay price`, slow for bulk scanning.
 *  - There is no schema enforcement, so output is validated and retried here.
 */
export function createCodexLlmClient ({
  bin = CODEX_BIN,
  timeoutMs = 180000,
  retries = 1,
  sandbox = 'read-only',
  model = null,
  tmpRoot = path.join(os.tmpdir(), 'fbay-codex'),
  runImpl = runCodex,
  fsImpl = fs,
} = {}) {
  function workspace () {
    const dir = path.join(tmpRoot, crypto.randomBytes(6).toString('hex'))
    fsImpl.mkdirSync(dir, { recursive: true })
    return dir
  }

  async function invoke ({ prompt, images = [] }) {
    const dir = workspace()
    try {
      const args = ['exec', '--skip-git-repo-check', '-s', sandbox]
      if (model) args.push('-m', model)

      images.forEach((img, i) => {
        const ext = (img.mediaType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg')
        const p = path.join(dir, `img${i}.${ext}`)
        fsImpl.writeFileSync(p, Buffer.from(img.base64, 'base64'))
        args.push('-i', p)
      })

      const outFile = path.join(dir, 'out.txt')
      args.push('-o', outFile, prompt)

      const r = await runImpl(bin, args, { cwd: dir, timeoutMs })
      if (!r.ok) return { ok: false, error: `codex failed: ${r.error}` }
      if (!fsImpl.existsSync(outFile)) return { ok: false, error: 'codex produced no output file' }
      return { ok: true, text: fsImpl.readFileSync(outFile, 'utf8') }
    } catch (e) {
      return { ok: false, error: `codex failed: ${String(e.message ?? e).slice(0, 200)}` }
    } finally {
      try { fsImpl.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }

  async function extractStructured ({ system, user, schema, images = [] }) {
    const prompt = `${system}\n\n${user}\n\n${schemaToPrompt(schema)}`
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await invoke({ prompt, images })
      if (!r.ok) { lastError = r.error; continue }
      const parsed = extractJson(r.text)
      if (parsed.ok) return { ok: true, data: parsed.data, usage: {}, model: model ?? 'codex' }
      lastError = parsed.error
    }
    return { ok: false, error: lastError }
  }

  async function completeText ({ system, user }) {
    const r = await invoke({ prompt: `${system}\n\n${user}` })
    return r.ok ? { ok: true, text: r.text.trim(), usage: {} } : { ok: false, error: r.error }
  }

  return { provider: 'codex', extractStructured, completeText }
}
