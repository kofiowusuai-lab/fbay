import Anthropic from '@anthropic-ai/sdk'
import { createOpenAiLlmClient } from './llm-openai.mjs'

export const MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  smart: 'claude-opus-5',
}

/**
 * Reports which credential FBay will use, without reading the secret itself.
 *
 * The SDK resolves credentials in its own order: ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN, then an `ant auth login` OAuth profile on disk. So an
 * unset API key does NOT mean unauthenticated - passing `apiKey: undefined`
 * would be wrong, because it stops the SDK falling through to the profile.
 *
 * A Claude Code subscription credential is deliberately not in this list: it is
 * scoped to Claude Code, not to arbitrary API calls from other programs.
 */
export function detectAuth (env = process.env, fs = null) {
  const forced = env.FBAY_LLM_PROVIDER

  if (forced !== 'openai') {
    if (env.ANTHROPIC_API_KEY) return { ok: true, provider: 'anthropic', mode: 'api_key', detail: 'anthropic: ANTHROPIC_API_KEY' }
    if (env.ANTHROPIC_AUTH_TOKEN) return { ok: true, provider: 'anthropic', mode: 'auth_token', detail: 'anthropic: ANTHROPIC_AUTH_TOKEN' }
    const home = env.HOME ?? ''
    const dir = env.ANTHROPIC_CONFIG_DIR || (home ? `${home}/.config/anthropic` : null)
    if (dir && fs?.existsSync?.(`${dir}/credentials`)) {
      return { ok: true, provider: 'anthropic', mode: 'oauth_profile', detail: `anthropic: oauth profile in ${dir}` }
    }
  }

  if (forced !== 'anthropic' && env.OPENAI_API_KEY) {
    return { ok: true, provider: 'openai', mode: 'api_key', detail: 'openai: OPENAI_API_KEY' }
  }

  if (forced) return { ok: false, provider: forced, mode: null, detail: `FBAY_LLM_PROVIDER=${forced} but no credential for it` }

  return {
    ok: false,
    provider: null,
    mode: null,
    detail: 'no credential: set ANTHROPIC_API_KEY or OPENAI_API_KEY (or run `ant auth login`)',
  }
}

/**
 * Picks a provider from whatever credential is present. Identity extraction
 * needs VISION - Marketplace titles like "MacBook Pro" carry no specs, so the
 * photos are the only signal. Any provider wired in here must accept images;
 * a text-only model would guess, and a confident wrong identity is worse than
 * no answer because it values the item against the wrong comps.
 */
export function createLlm (opts = {}) {
  const auth = detectAuth(opts.env ?? process.env, opts.fs ?? null)
  if (auth.provider === 'openai') return createOpenAiLlmClient(opts)
  return createLlmClient(opts)
}

export function createLlmClient ({
  apiKey = process.env.ANTHROPIC_API_KEY,
  anthropic = null,
  defaultModel = MODELS.fast,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  // Only pass apiKey when we actually have one. Passing an explicit undefined
  // short-circuits the SDK's own credential chain, which would break the
  // no-API-key OAuth-profile path.
  const api = anthropic ?? new Anthropic(apiKey ? { apiKey } : {})

  async function extractStructured ({ system, user, schema, images = [], model = defaultModel, maxTokens = 1024 }) {
    const content = [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      })),
      { type: 'text', text: user },
    ]

    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await api.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }],
          tools: [{
            name: 'emit',
            description: 'Emit the extracted structured result. This is the only valid way to answer.',
            input_schema: schema,
          }],
          tool_choice: { type: 'tool', name: 'emit' },
        })
        const block = (res.content ?? []).find((c) => c.type === 'tool_use')
        if (!block) {
          lastError = 'model returned no structured output'
        } else {
          return { ok: true, data: block.input, usage: res.usage ?? {}, model: res.model ?? model }
        }
      } catch (e) {
        lastError = e.message ?? String(e)
      }
      if (attempt < retries) await sleepImpl(500 * 2 ** attempt)
    }
    return { ok: false, error: lastError }
  }

  async function completeText ({ system, user, model = defaultModel, maxTokens = 512 }) {
    try {
      const res = await api.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      })
      const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim()
      return { ok: true, text, usage: res.usage ?? {} }
    } catch (e) {
      return { ok: false, error: e.message ?? String(e) }
    }
  }

  return { provider: 'anthropic', extractStructured, completeText }
}
