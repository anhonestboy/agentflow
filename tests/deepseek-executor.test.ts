import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { DeepSeekExecutor } from '../src/executors/deepseek-executor.js';
import type { AgentDef } from '../src/types.js';

// ─── Fetch mock helpers ────────────────────────────────────────────

function mockFetchOnce(content: string, ok = true, status = 200) {
  const body = ok ? { choices: [{ message: { content } }] } : { error: { message: content } };
  const fn = jest.fn<() => Promise<Response>>().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
  return fn as unknown as typeof global.fetch;
}

const REVIEWER: AgentDef = {
  id: 'critic',
  mode: 'adversarial',
  must_produce: [{ name: 'verdict' }, { name: 'confidence', type: 'float' }],
} as AgentDef;

describe('DeepSeekExecutor', () => {
  const realFetch = global.fetch;
  const realKey = process.env.DEEPSEEK_API_KEY;

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-key-123';
  });
  afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realKey;
    jest.restoreAllMocks();
  });

  test('throws if DEEPSEEK_API_KEY is missing', () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => new DeepSeekExecutor('deepseek-chat')).toThrow(/DEEPSEEK_API_KEY/);
  });

  test('parses a plain JSON response', async () => {
    global.fetch = mockFetchOnce('{"verdict": "approved", "confidence": 0.9}');
    const exec = new DeepSeekExecutor('deepseek-chat');
    const { output, metrics } = await exec.execute(REVIEWER, { draft: 'x' });
    expect(output.verdict).toBe('approved');
    expect(output.confidence).toBe(0.9);
    expect(metrics?.tool_calls).toBe(0);
  });

  test('calls the DeepSeek endpoint with a Bearer token', async () => {
    const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"verdict": "approved", "confidence": 1}' } }],
      }),
      text: async () => '',
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const exec = new DeepSeekExecutor('deepseek-reasoner');
    await exec.execute(REVIEWER, {});
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-123');
    expect(JSON.parse(init.body as string).model).toBe('deepseek-reasoner');
  });

  test('extracts JSON from a fenced code block', async () => {
    global.fetch = mockFetchOnce(
      'Sure:\n```json\n{"verdict": "Approved", "confidence": "0.85"}\n```',
    );
    const exec = new DeepSeekExecutor('deepseek-chat');
    const { output } = await exec.execute(REVIEWER, {});
    expect(output.verdict).toBe('approved'); // normalized
    expect(output.confidence).toBe(0.85); // string "0.85" parsed
  });

  test('normalizes verdict variants and >1 confidence', async () => {
    global.fetch = mockFetchOnce('{"verdict": "Needs Work", "confidence": 42}');
    const exec = new DeepSeekExecutor('deepseek-chat');
    const { output } = await exec.execute(REVIEWER, {});
    expect(output.verdict).toBe('needs_work');
    expect(output.confidence).toBe(0.42);
  });

  test('repairs truncated JSON instead of throwing', async () => {
    // Missing closing brace and quote — should be repaired.
    global.fetch = mockFetchOnce('{"verdict": "approved", "confidence": 0.7');
    const exec = new DeepSeekExecutor('deepseek-chat');
    const { output } = await exec.execute(REVIEWER, {});
    expect(output.verdict).toBe('approved');
  });

  test('applies fuzzy field aliasing (bugs → bug_report)', async () => {
    const agent: AgentDef = {
      id: 'tester',
      mode: 'precise',
      must_produce: [{ name: 'bug_report' }],
    } as AgentDef;
    global.fetch = mockFetchOnce('{"bugs": "found a null deref"}');
    const exec = new DeepSeekExecutor('deepseek-chat');
    const { output } = await exec.execute(agent, {});
    expect(output.bug_report).toBe('found a null deref');
  });

  test('throws a clear error on a non-OK HTTP response', async () => {
    // 400 is not in the retryable set, so this surfaces immediately (no backoff).
    global.fetch = mockFetchOnce('bad request', false, 400);
    const exec = new DeepSeekExecutor('deepseek-chat');
    await expect(exec.execute(REVIEWER, {})).rejects.toThrow(/DeepSeek 400/);
  });
});
