const API_URL = 'https://api.openai.com/v1/chat/completions'

export const OPENAI_MODELS = {
  fast: 'gpt-5-mini',
  smart: 'gpt-5',
}

/**
 * OpenAI's json_schema strict mode requires every property to appear in
 * `required` and `additionalProperties: false` on every object. Our schema
 * marks several fields optional, so translate rather than hand-maintain two
 * copies that can drift apart.
 *
 * Making a field required is safe here: the prompt already instructs the model
 * to emit an empty string or 0 when a value is unknown, and normaliseIdentity
 * converts those back to null.
 */
export function toStrictSchema (schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (schema.type === 'array') return { ...schema, items: toStrictSchema(schema.items) }
  if (schema.type !== 'object' || !schema.properties) return schema

  const properties = {}
  for (const [k, v] of Object.entries(schema.properties)) properties[k] = toStrictSchema(v)

  return {
    ...schema,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

/** The gpt-5 family renamed the output cap and rejects the old name. */
export function tokenLimitField (model) {
  return /^(gpt-5|o[34])/.test(model) ? 'max_completion_tokens' : 'max_tokens'
}

export function buildContent ({ user, images }) {
  return [
    ...images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
    })),
    { type: 'text', text: user },
  ]
}

/**
 * Satisfies the same interface as the Anthropic client in llm.mjs:
 * extractStructured({system, user, schema, images, model}) and completeText().
 * Nothing outside this file knows which provider is in use.
 */
export function createOpenAiLlmClient ({
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = globalThis.fetch,
  defaultModel = OPENAI_MODELS.fast,
  smartModel = OPENAI_MODELS.smart,
  retries = 2,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  async function call (body) {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, error: `openai ${res.status}: ${(await res.text()).slice(0, 200)}` }
    return { ok: true, body: await res.json() }
  }

  async function extractStructured ({ system, user, schema, images = [], model = defaultModel, maxTokens = 1024 }) {
    // The caller passes Anthropic model ids; map the tier across rather than
    // leaking provider-specific names into identify/extract.mjs.
    const resolved = /opus|sonnet/i.test(model) ? smartModel : /haiku/i.test(model) ? defaultModel : model

    const body = {
      model: resolved,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: buildContent({ user, images }) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extraction', strict: true, schema: toStrictSchema(schema) },
      },
      [tokenLimitField(resolved)]: maxTokens,
    }

    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await call(body)
      if (r.ok) {
        const choice = r.body.choices?.[0]
        const text = choice?.message?.content
        if (choice?.finish_reason === 'length') {
          lastError = 'response truncated before the JSON closed (raise maxTokens)'
        } else if (!text) {
          lastError = 'model returned no content'
        } else {
          try {
            return {
              ok: true,
              data: JSON.parse(text),
              usage: r.body.usage ?? {},
              model: r.body.model ?? resolved,
            }
          } catch (e) {
            lastError = `structured output was not valid JSON: ${e.message}`
          }
        }
      } else {
        lastError = r.error
      }
      if (attempt < retries) await sleepImpl(500 * 2 ** attempt)
    }
    return { ok: false, error: lastError }
  }

  async function completeText ({ system, user, model = defaultModel, maxTokens = 512 }) {
    const resolved = /opus|sonnet/i.test(model) ? smartModel : /haiku/i.test(model) ? defaultModel : model
    const r = await call({
      model: resolved,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      [tokenLimitField(resolved)]: maxTokens,
    })
    if (!r.ok) return { ok: false, error: r.error }
    const text = r.body.choices?.[0]?.message?.content
    if (!text) return { ok: false, error: 'model returned no content' }
    return { ok: true, text: text.trim(), usage: r.body.usage ?? {} }
  }

  return { provider: 'openai', extractStructured, completeText }
}
