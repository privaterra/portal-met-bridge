// Thin clients for the three AI providers the Analysis tab can use. Calls go
// straight from the browser to the provider (the page runs on localhost); the
// key is sent only to the provider chosen. Request building and stream parsing
// are pure so they can be unit-tested; only streamCompletion/listModels fetch.

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
    docs: 'https://docs.claude.com',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-6.1-sol',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    docs: 'https://developers.openai.com/api/docs',
  },
  google: {
    label: 'Gemini (Google)',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.8-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza…',
    docs: 'https://ai.google.dev/gemini-api/docs',
  },
};

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

/** Base URL for a provider: the user's override (OpenAI-compatible servers, proxies) or the default. */
export function baseUrlFor(provider, override) {
  const o = trimSlash(override);
  return o || PROVIDERS[provider]?.baseUrl || '';
}

/**
 * Build the HTTP request for one completion.
 * Returns { url, headers, body } — body is the object, not yet serialised.
 *
 * Sampling knobs are left at the provider's defaults: the current reasoning
 * models reject `temperature` outright (Anthropic answers HTTP 400
 * "`temperature` is deprecated for this model" for Opus 5.5; OpenAI's
 * reasoning models answer "Unsupported parameter"), and a shot review does
 * not need it. Pass `temperature` explicitly to send one, e.g. for an older
 * model behind a compatible endpoint.
 */
export function buildRequest(provider, { model, key, system, user, maxTokens = 8000, temperature, stream = true, baseUrl } = {}) {
  const base = baseUrlFor(provider, baseUrl);
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider "${provider}"`);
  if (!model) throw new Error('No model chosen');
  if (!key) throw new Error('No API key');
  const sampling = Number.isFinite(temperature) ? { temperature } : {};
  if (provider === 'anthropic') {
    return {
      url: `${base}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // required for a page to call the API directly
      },
      body: { model, max_tokens: maxTokens, ...sampling, system, messages: [{ role: 'user', content: user }], stream },
    };
  }
  if (provider === 'openai') {
    return {
      url: `${base}/v1/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...sampling, stream },
    };
  }
  // google
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return {
    url: `${base}/v1beta/models/${encodeURIComponent(model)}:${method}`,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { ...sampling, maxOutputTokens: maxTokens },
    },
  };
}

/** Optional body fields a model may refuse; dropped on a retry after an HTTP 400 that names one of them. */
const OPTIONAL_PARAMS = ['temperature', 'top_p', 'top_k'];
const PARAM_REJECTED = /temperature|top_p|top_k|unsupported parameter|not supported with this model|deprecated for this model|unknown parameter|unrecognized request argument/i;

/** True when a 400 says the model refused an optional sampling parameter (not a bad key, model or body). */
export function isParamRejection(status, message) {
  return status === 400 && PARAM_REJECTED.test(String(message || ''));
}

/** The same body with the optional sampling parameters removed (also inside Gemini's generationConfig); null if nothing to remove. */
export function stripOptionalParams(body) {
  let changed = false;
  const out = { ...body };
  for (const k of OPTIONAL_PARAMS) if (k in out) { delete out[k]; changed = true; }
  if (out.generationConfig) {
    const gc = { ...out.generationConfig };
    for (const k of ['temperature', 'topP', 'topK']) if (k in gc) { delete gc[k]; changed = true; }
    out.generationConfig = gc;
  }
  return changed ? out : null;
}

/**
 * Text delta carried by one SSE `data:` payload, or '' when it carries none;
 * returns null for the end-of-stream marker. Never throws on odd input.
 */
export function deltaFromEvent(provider, data) {
  if (data == null) return '';
  const trimmed = String(data).trim();
  if (!trimmed) return '';
  if (trimmed === '[DONE]') return null;
  let j;
  try {
    j = JSON.parse(trimmed);
  } catch {
    return '';
  }
  if (provider === 'anthropic') {
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') return j.delta.text || '';
    if (j.type === 'message_stop') return null;
    if (j.type === 'error') throw new Error(j.error?.message || 'stream error');
    return '';
  }
  if (provider === 'openai') {
    if (j.error) throw new Error(j.error.message || 'stream error');
    const ch = j.choices?.[0];
    if (!ch) return '';
    if (ch.delta?.content) return ch.delta.content;
    return '';
  }
  // google
  if (j.error) throw new Error(j.error.message || 'stream error');
  const parts = j.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p.text || '').join('');
  return '';
}

/** The full text of a non-streamed response body. */
export function textFromResponse(provider, j) {
  if (provider === 'anthropic') return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (provider === 'openai') return j.choices?.[0]?.message?.content || '';
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

/**
 * Incremental SSE parser: feed it chunks of text, get back the `data:` payloads
 * of every complete event. Keeps the unfinished remainder between calls.
 */
export function makeSseParser() {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const events = [];
      let idx;
      // events are separated by a blank line (\n\n or \r\n\r\n)
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const dataLines = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''));
        if (dataLines.length) events.push(dataLines.join('\n'));
      }
      return events;
    },
    flush() {
      const rest = buf;
      buf = '';
      const dataLines = rest
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''));
      return dataLines.length ? [dataLines.join('\n')] : [];
    },
  };
}

/** A readable error from a failed HTTP response (provider error JSON when present); carries .status and .detail. */
async function httpError(r, provider) {
  let detail = '';
  try {
    const j = JSON.parse(await r.text());
    detail = j.error?.message || j.message || (typeof j.error === 'string' ? j.error : '') || '';
  } catch {
    /* no JSON body */
  }
  const err = new Error(`${PROVIDERS[provider]?.label || provider}: HTTP ${r.status}${detail ? ` · ${detail}` : ''}${hintFor(r.status)}`);
  err.status = r.status;
  err.detail = detail;
  return err;
}

function hintFor(status) {
  if (status === 401 || status === 403) return ' — check the API key under Settings → AI review';
  if (status === 404) return ' — the model name is probably wrong; press "List models"';
  if (status === 429) return ' — rate limit or no credit on the account';
  if (status === 0) return ' — the browser blocked the request (CORS); see the README';
  return '';
}

/**
 * Stream one completion. onDelta(text) is called for every piece; resolves to
 * the full text. `signal` aborts. Falls back to a non-streamed request when the
 * response is not an event stream (some proxies).
 */
export async function streamCompletion(provider, opts, { onDelta, signal, fetchImpl = fetch, onRetry } = {}) {
  const req = buildRequest(provider, { ...opts, stream: true });
  const send = async (body) => {
    try {
      return await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new Error(`${PROVIDERS[provider]?.label || provider}: could not reach ${new URL(req.url).host} (${err?.message || err}). If this is a CORS error in the console, the endpoint does not allow browser calls; see the README.`);
    }
  };
  let r = await send(req.body);
  if (!r.ok) {
    const err = await httpError(r, provider);
    // a model that refuses a sampling parameter gets the same request once more without it
    const stripped = isParamRejection(err.status, err.detail) ? stripOptionalParams(req.body) : null;
    if (!stripped) throw err;
    onRetry?.(err);
    r = await send(stripped);
    if (!r.ok) throw await httpError(r, provider);
  }
  const ctype = r.headers.get('content-type') || '';
  if (!/text\/event-stream/i.test(ctype)) {
    const j = JSON.parse(await r.text());
    const text = textFromResponse(provider, j);
    onDelta?.(text);
    return text;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const parser = makeSseParser();
  let full = '';
  const handle = (events) => {
    for (const ev of events) {
      const d = deltaFromEvent(provider, ev);
      if (d === null) return true;
      if (d) {
        full += d;
        onDelta?.(d);
      }
    }
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (handle(parser.push(decoder.decode(value, { stream: true })))) break;
  }
  handle(parser.flush());
  return full;
}

/** Models the key can use, newest-ish first; [{ id, label }]. */
export async function listModels(provider, { key, baseUrl, fetchImpl = fetch } = {}) {
  const base = baseUrlFor(provider, baseUrl);
  if (!key) throw new Error('No API key');
  let url;
  let headers;
  if (provider === 'anthropic') {
    url = `${base}/v1/models?limit=100`;
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  } else if (provider === 'openai') {
    url = `${base}/v1/models`;
    headers = { authorization: `Bearer ${key}` };
  } else {
    url = `${base}/v1beta/models?pageSize=200`;
    headers = { 'x-goog-api-key': key };
  }
  const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw await httpError(r, provider);
  const j = await r.json();
  return normalizeModelList(provider, j);
}

/** Pure: the provider's model-list JSON → [{ id, label }] filtered to text models. */
export function normalizeModelList(provider, j) {
  let items = [];
  if (provider === 'anthropic') items = (j.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id, created: m.created_at || '' }));
  else if (provider === 'openai') {
    items = (j.data || [])
      .map((m) => ({ id: m.id, label: m.id, created: m.created || 0 }))
      .filter((m) => !/(audio|realtime|image|tts|transcribe|whisper|embedding|moderation|search|codex|dall-e|sora|live|davinci|babbage|instruct)/i.test(m.id)); // any id a compatible server offers, minus the obvious non-chat ones
  } else {
    items = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name, created: '' }))
      .filter((m) => /gemini/i.test(m.id) && !/(embedding|aqa|imagen|veo|tts|audio|image|live|native)/i.test(m.id));
  }
  items.sort((a, b) => (b.created > a.created ? 1 : b.created < a.created ? -1 : a.id.localeCompare(b.id)));
  return items;
}

/** The cheapest round trip that proves the key and model work: a one-word answer. */
export async function testKey(provider, { key, model, baseUrl, fetchImpl = fetch } = {}) {
  const text = await streamCompletion(provider, { key, model, baseUrl, system: 'Answer with the single word OK.', user: 'Ready?', maxTokens: 16 }, { fetchImpl });
  return text.trim();
}

/** "sk-ant-…h4Q" — enough to recognise a key, never enough to use it. */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 10) return '•'.repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
