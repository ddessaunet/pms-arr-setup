// stack/lib/ai.ts — the models Ask AI may use (/requests/), and the one way to
// ask each. jobs/stack-api is the only caller, and only when the owner clicks:
// a page load, a poll or a timer never asks a model, so a paid one is never
// spent by accident.
//
// The list is an allowlist from .env: AI_MODELS (comma-separated
// "provider/model", e.g. ollama/qwen2.5:3b; "off" for none) and AI_MODEL, the
// one asked by default. Each entry splits on its first "/", so Ollama's
// name:tag survives. Unset: just ollama/qwen2.5:3b. A provider this file has
// no client for is dropped with a warning, so a typo never reaches a request.
//
// Providers: ollama, the local one (native ollama.service on 127.0.0.1:11434,
// outside compose; OLLAMA_URL to point elsewhere). A paid API (anthropic) goes
// beside it as one more branch of providerFor, with its key in .env (*_KEY, so
// secret by name).

import { is2xx, jsonOf, type Http } from './http.ts';
import type { AiInfo, AiModel } from './request-doctor.ts';

export const DEFAULT_MODELS = 'ollama/qwen2.5:3b';
export const OLLAMA_URL = 'http://127.0.0.1:11434';
const PROVIDERS = new Set(['ollama']);

export interface Prompt {
  system: string;
  user: string;
}

export type Completion = { ok: true; text: string; inTokens: number; outTokens: number } | { ok: false; error: string };

export interface AiProvider {
  provider: string;
  model: string;
  complete(p: Prompt, timeoutMs: number): Promise<Completion>;
}

/** AI_MODELS and AI_MODEL as the allowlist; info is null when AI is off (or nothing usable is listed). */
export function parseModels(models: string, dflt: string): { info: AiInfo | null; warnings: string[] } {
  const raw = models.trim() || DEFAULT_MODELS;
  if (raw.toLowerCase() === 'off') return { info: null, warnings: [] };
  const warnings: string[] = [];
  const list: AiModel[] = [];
  for (const entry of raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const slash = entry.indexOf('/');
    const provider = slash > 0 ? entry.slice(0, slash) : '';
    const model = slash > 0 ? entry.slice(slash + 1).trim() : '';
    if (!provider || !model) warnings.push(`AI_MODELS: "${entry}" is not provider/model; skipped`);
    else if (!PROVIDERS.has(provider)) warnings.push(`AI_MODELS: no client for provider "${provider}"; skipped`);
    else if (!list.some((m) => m.id === entry)) list.push({ id: entry, provider, model });
  }
  if (list.length === 0) {
    warnings.push('AI_MODELS lists no usable model: AI is off');
    return { info: null, warnings };
  }
  const wanted = dflt.trim();
  const first = list[0] as AiModel;
  if (wanted && !list.some((m) => m.id === wanted))
    warnings.push(`AI_MODEL "${wanted}" is not in AI_MODELS; the default is ${first.id}`);
  return { info: { models: list, default: list.some((m) => m.id === wanted) ? wanted : first.id }, warnings };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Ollama's /api/chat, one answer, not streamed. */
export function ollama(http: Http, base: string, model: string): AiProvider {
  const url = `${base.replace(/\/+$/, '')}/api/chat`;
  return {
    provider: 'ollama',
    model,
    async complete(p, timeoutMs) {
      const r = await http(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          // Low temperature: it should restate the facts, not invent around them.
          options: { temperature: 0.2, num_predict: 300 },
          // Kept loaded a while for a second question, then out of the RAM Plex wants.
          keep_alive: '10m',
          messages: [
            { role: 'system', content: p.system },
            { role: 'user', content: p.user },
          ],
        }),
        timeoutMs,
      });
      if (r.status === 0) return { ok: false, error: `ollama is not answering at ${base} (${r.error ?? 'no answer'})` };
      const json = jsonOf(r);
      const said = isObj(json) && typeof json.error === 'string' ? json.error : '';
      if (r.status === 404) return { ok: false, error: `ollama has no model ${model}; run: ollama pull ${model}` };
      if (!is2xx(r.status)) return { ok: false, error: `ollama answered ${r.status}${said ? `: ${said}` : ''}` };
      const text =
        isObj(json) && isObj(json.message) && typeof json.message.content === 'string' ? json.message.content : '';
      if (!text.trim()) return { ok: false, error: 'ollama answered with no text' };
      return {
        ok: true,
        text: text.trim(),
        inTokens: isObj(json) ? num(json.prompt_eval_count) : 0,
        outTokens: isObj(json) ? num(json.eval_count) : 0,
      };
    },
  };
}

/** The client for one listed model; null for a provider without one (parseModels already dropped those). */
export function providerFor(m: AiModel, cfg: { http: Http; ollamaUrl: string }): AiProvider | null {
  if (m.provider === 'ollama') return ollama(cfg.http, cfg.ollamaUrl || OLLAMA_URL, m.model);
  return null;
}
