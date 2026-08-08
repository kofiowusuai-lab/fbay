import Anthropic from '@anthropic-ai/sdk'

export const MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  smart: 'claude-opus-5',
}

export function createLlmClient ({
  apiKey = process.env.ANTHROPIC_API_KEY,
  anthropic = null,
  defaultModel = MODELS.fast,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const api = anthropic ?? new Anthropic({ apiKey })

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

  return { extractStructured, completeText }
}
