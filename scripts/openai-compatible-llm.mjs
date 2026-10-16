/**
 * An OpenAI-compatible LLM service for the standalone music server, in the
 * shape the DJ consumes (`resolveLlm` in `lib/dj.js`):
 *
 *   stream({provider, model, messages, sessionId}) -> async iterable of
 *     {type: 'text-delta', text} | {type: 'finish', reason} | {type: 'error', failure}
 *
 * Any endpoint speaking `/chat/completions` with SSE streaming works —
 * DeepSeek, OpenAI, a local server, …
 *
 * @module dsh-music/standalone/openai-compatible-llm
 */

export class OpenAiCompatibleLlm {
  /**
   * @param {object} options
   * @param {string} options.baseUrl e.g. `https://api.deepseek.com/v1`.
   * @param {string} options.apiKey bearer token.
   * @param {string} [options.provider] name the DJ pins and reports (default `openai-compatible`).
   * @param {string} [options.model] the one model this adapter offers when `/models` fails.
   * @param {number} [options.timeoutMs]
   * @param {{warn?: Function}} [options.logger]
   */
  constructor({ baseUrl, apiKey, provider = 'openai-compatible', model, timeoutMs = 60_000, logger }) {
    if (!baseUrl || !apiKey) throw new Error('OpenAiCompatibleLlm needs baseUrl and apiKey');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.provider = provider;
    this.model = model ?? null;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  listProviders() {
    return [{ id: this.provider }];
  }

  /** The catalogue for the panel's model picker; the pinned model when the endpoint will not list. */
  async listModels() {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const models = (body.data ?? []).map((entry) => ({ id: entry.id, name: entry.id })).filter((entry) => entry.id);
      if (models.length > 0) return models;
    } catch (error) {
      this.logger?.warn?.(`[music] DJ model catalogue unavailable: ${error.message}`);
    }
    return this.model ? [{ id: this.model, name: this.model }] : [];
  }

  /**
   * Stream one chat completion as DJ-shaped chunks.
   *
   * `sessionId` rides along as a header: OpenAI-compatible bodies have no
   * standard place for it, and a strict endpoint rejects unknown body fields.
   */
  async *stream({ provider, model, messages, sessionId }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify({ model, messages, stream: true }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        yield {
          type: 'error',
          failure: { code: response.status === 401 || response.status === 403 ? 'AUTH' : `HTTP_${response.status}`, message: `${provider}: HTTP ${response.status} ${detail}`.trim() },
        };
        return;
      }

      let buffer = '';
      const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const data = line.trim();
          if (!data.startsWith('data:')) continue;
          const payload = data.slice(5).trim();
          if (payload === '[DONE]') continue;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) yield { type: 'text-delta', text: delta };
        }
      }
      yield { type: 'finish', reason: 'stop' };
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          code: error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
          message: `${provider}: ${error.message}`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
