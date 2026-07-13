import { jest, describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import { OllamaExecutor } from '../src/executors/ollama-executor.js';
import type { AgentDef } from '../src/types.js';

function mockOllamaOnce(content: string, ok = true, status = 200) {
  const fn = jest.fn<() => Promise<Response>>().mockResolvedValue({
    ok,
    status,
    json: async () => ({ message: { content } }),
    text: async () => content,
  } as unknown as Response);
  return fn as unknown as typeof global.fetch;
}

const REVIEWER: AgentDef = {
  id: 'critic',
  mode: 'adversarial',
  must_produce: [{ name: 'verdict' }, { name: 'confidence', type: 'float' }],
} as AgentDef;

describe('OllamaExecutor', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  test('constructs without an API key and uses the configured model', () => {
    expect(() => new OllamaExecutor({ provider: 'ollama', model: 'qwen3:8b' })).not.toThrow();
  });

  test('parses a plain JSON response and reports zero tool calls', async () => {
    global.fetch = mockOllamaOnce('{"verdict": "approved", "confidence": 0.88}');
    const exec = new OllamaExecutor({ provider: 'ollama', model: 'qwen3:8b' });
    const { output, metrics } = await exec.execute(REVIEWER, { draft: 'x' });
    expect(output.verdict).toBe('approved');
    expect(output.confidence).toBe(0.88);
    expect(metrics?.tool_calls).toBe(0);
  });

  test('normalizes verdict and scales >1 numeric confidence', async () => {
    global.fetch = mockOllamaOnce('{"verdict": "NEEDS WORK", "confidence": 73}');
    const exec = new OllamaExecutor({ provider: 'ollama', model: 'qwen3:8b' });
    const { output } = await exec.execute(REVIEWER, {});
    expect(output.verdict).toBe('needs_work');
    expect(output.confidence).toBe(0.73);
  });

  test('applies field aliasing (improvements → improvement_list)', async () => {
    const agent: AgentDef = {
      id: 'editor',
      mode: 'precise',
      must_produce: [{ name: 'improvement_list' }],
    } as AgentDef;
    global.fetch = mockOllamaOnce('{"improvements": "tighten the intro"}');
    const exec = new OllamaExecutor({ provider: 'ollama', model: 'qwen3:8b' });
    const { output } = await exec.execute(agent, {});
    expect(output.improvement_list).toBe('tighten the intro');
  });

  test('throws on unparseable JSON', async () => {
    global.fetch = mockOllamaOnce('not json at all');
    const exec = new OllamaExecutor({ provider: 'ollama', model: 'qwen3:8b' });
    await expect(exec.execute(REVIEWER, {})).rejects.toThrow(/Unparseable JSON/);
  });

  test('posts to the Ollama chat endpoint', async () => {
    const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '{"verdict": "approved", "confidence": 1}' } }),
      text: async () => '',
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const exec = new OllamaExecutor({ provider: 'ollama', model: 'qwen3:8b' });
    await exec.execute(REVIEWER, {});
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toMatch(/\/api\/chat$/);
  });

  test('uses the RESOLVED model in the request body (not the env default)', async () => {
    const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '{"verdict": "approved", "confidence": 1}' } }),
      text: async () => '',
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;
    await new OllamaExecutor({ provider: 'ollama', model: 'llama3:70b' }).execute(REVIEWER, {});
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe('llama3:70b');
  });

  test('throws a clear error with status + body on a non-OK HTTP response', async () => {
    // 400 is not retryable, so it surfaces immediately (no backoff, no JSON.parse(undefined)).
    const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'bad model name',
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const exec = new OllamaExecutor({ provider: 'ollama', model: 'm' });
    await expect(exec.execute(REVIEWER, {})).rejects.toThrow(/Ollama 400: bad model name/);
  });

  test('retries a transient 5xx failure then succeeds (wrapped in withRetry)', async () => {
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'busy' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: '{"verdict": "approved", "confidence": 1}' } }),
        text: async () => '',
      };
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const { output } = await new OllamaExecutor({ provider: 'ollama', model: 'm' }).execute(
      REVIEWER,
      {},
    );
    expect(output.verdict).toBe('approved');
    expect(calls).toBe(2);
  });

  test('records token usage when Ollama reports it (local → cost not counted)', async () => {
    const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: '{"verdict": "approved", "confidence": 1}' },
        prompt_eval_count: 120,
        eval_count: 30,
      }),
      text: async () => '',
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const { metrics } = await new OllamaExecutor({ provider: 'ollama', model: 'qwen3:8b' }).execute(
      REVIEWER,
      {},
    );
    expect(metrics?.usage).toEqual({ prompt_tokens: 120, completion_tokens: 30 });
    expect(metrics?.cost_usd).toBeUndefined();
    expect(metrics?.model).toBe('qwen3:8b');
  });
});
