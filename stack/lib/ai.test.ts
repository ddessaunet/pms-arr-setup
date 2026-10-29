// stack/lib/ai.test.ts — the AI_MODELS allowlist, and Ollama's client against
// a fake Http (jobs/stack-api/stack-api.test.ts runs it through the route).

import { describe, expect, test } from 'bun:test';
import { ollama, parseModels, providerFor } from './ai.ts';
import type { Http, HttpRequest } from './http.ts';

describe('parseModels', () => {
  test('unset: the local default', () =>
    expect(parseModels('', '')).toEqual({
      info: {
        models: [{ id: 'ollama/qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b' }],
        default: 'ollama/qwen2.5:3b',
      },
      warnings: [],
    }));

  test('off', () => expect(parseModels(' OFF ', 'ollama/llama3.2')).toEqual({ info: null, warnings: [] }));

  test('a list, name:tag kept, duplicates once, the default from AI_MODEL', () => {
    const { info, warnings } = parseModels('ollama/qwen2.5:3b, ollama/llama3.2 ,ollama/qwen2.5:3b', 'ollama/llama3.2');
    expect(info?.models.map((m) => `${m.provider} ${m.model}`)).toEqual(['ollama qwen2.5:3b', 'ollama llama3.2']);
    expect([info?.default, warnings]).toEqual(['ollama/llama3.2', []]);
  });

  test('a model with a namespace keeps it', () =>
    expect(parseModels('ollama/library/mistral:7b', '').info?.models[0]?.model).toBe('library/mistral:7b'));

  test('unknown providers and bad entries are dropped, with a warning each', () => {
    const { info, warnings } = parseModels('anthropic/claude-haiku-5-5,qwen,ollama/llama3.2', '');
    expect(info?.models.map((m) => m.id)).toEqual(['ollama/llama3.2']);
    expect(warnings).toEqual([
      'AI_MODELS: no client for provider "anthropic"; skipped',
      'AI_MODELS: "qwen" is not provider/model; skipped',
    ]);
  });

  test('nothing usable: off, and says so', () =>
    expect(parseModels('nope/x', '')).toEqual({
      info: null,
      warnings: ['AI_MODELS: no client for provider "nope"; skipped', 'AI_MODELS lists no usable model: AI is off'],
    }));

  test('a default not on the list: the first, and a warning', () => {
    const { info, warnings } = parseModels('ollama/llama3.2', 'ollama/mistral');
    expect(info?.default).toBe('ollama/llama3.2');
    expect(warnings).toEqual(['AI_MODEL "ollama/mistral" is not in AI_MODELS; the default is ollama/llama3.2']);
  });
});

describe('ollama', () => {
  const reply = (status: number, body: unknown, error?: string) => ({
    status,
    text: JSON.stringify(body),
    headers: new Headers(),
    error,
  });
  function fake(res: ReturnType<typeof reply>) {
    const seen: { url: string; req: HttpRequest }[] = [];
    const http: Http = async (url, req) => {
      seen.push({ url, req });
      return res;
    };
    return { http, seen };
  }
  const prompt = { system: 'sys', user: 'facts' };

  test('one /api/chat, not streamed, with the picked model; the text and token counts back', async () => {
    const { http, seen } = fake(
      reply(200, {
        message: { role: 'assistant', content: '  Waiting.\n\nNext: wait. ' },
        prompt_eval_count: 9,
        eval_count: 3,
      }),
    );
    const r = await ollama(http, 'http://ai.test:11434/', 'llama3.2').complete(prompt, 1000);
    expect(r).toEqual({ ok: true, text: 'Waiting.\n\nNext: wait.', inTokens: 9, outTokens: 3 });
    expect(seen[0]?.url).toBe('http://ai.test:11434/api/chat');
    expect(seen[0]?.req.timeoutMs).toBe(1000);
    const body = JSON.parse(String(seen[0]?.req.body)) as Record<string, unknown>;
    expect([body.model, body.stream]).toEqual(['llama3.2', false]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'facts' },
    ]);
  });

  test('a model it has not pulled: how to get it', async () =>
    expect(
      await ollama(fake(reply(404, { error: "model 'x' not found" })).http, 'http://a', 'x').complete(prompt, 1),
    ).toEqual({
      ok: false,
      error: 'ollama has no model x; run: ollama pull x',
    }));

  test('another refusal, no answer, or no text', async () => {
    expect(
      await ollama(fake(reply(500, { error: 'out of memory' })).http, 'http://a', 'x').complete(prompt, 1),
    ).toEqual({
      ok: false,
      error: 'ollama answered 500: out of memory',
    });
    expect(await ollama(fake(reply(0, '', 'timed out')).http, 'http://a', 'x').complete(prompt, 1)).toEqual({
      ok: false,
      error: 'ollama is not answering at http://a (timed out)',
    });
    expect(
      await ollama(fake(reply(200, { message: { content: ' ' } })).http, 'http://a', 'x').complete(prompt, 1),
    ).toEqual({
      ok: false,
      error: 'ollama answered with no text',
    });
  });

  test('providerFor: Ollama at its default address unless told; nothing for another provider', () => {
    const http: Http = async () => reply(200, {});
    const p = providerFor({ id: 'ollama/x', provider: 'ollama', model: 'x' }, { http, ollamaUrl: '' });
    expect([p?.provider, p?.model]).toEqual(['ollama', 'x']);
    expect(providerFor({ id: 'anthropic/x', provider: 'anthropic', model: 'x' }, { http, ollamaUrl: '' })).toBeNull();
  });
});
