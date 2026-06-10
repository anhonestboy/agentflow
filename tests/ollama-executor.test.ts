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
});
