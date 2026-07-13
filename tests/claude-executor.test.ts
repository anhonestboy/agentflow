import { jest, describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import { ClaudeExecutor } from '../src/executors/claude-executor.js';
import { resolveModel } from '../src/model-resolver.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentDef } from '../src/types.js';

// Minimal fake of the Anthropic client surface ClaudeExecutor uses.
function fakeClient(responses: unknown[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: jest.fn(async () => responses[Math.min(i++, responses.length - 1)]),
    },
  } as unknown as Anthropic;
}

const AGENT: AgentDef = {
  id: 'writer',
  mode: 'focused',
  model: 'claude-sonnet-4-5',
  must_produce: [{ name: 'draft' }, { name: 'word_count', type: 'int' }],
} as AgentDef;

describe('ClaudeExecutor (injected client)', () => {
  test('returns the produce_output tool input as the agent output', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: 'produce_output',
            id: 'tu_1',
            input: { draft: 'hello world', word_count: 2 },
          },
        ],
      },
    ]);
    const exec = new ClaudeExecutor({ client });
    const { output, metrics } = await exec.execute(AGENT, { topic: 'x' });
    expect(output.draft).toBe('hello world');
    expect(output.word_count).toBe(2);
    expect(metrics?.tool_calls).toBe(0);
  });

  test('asks again when the model replies with text only, then completes', async () => {
    const client = fakeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'thinking...' }] },
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: 'produce_output',
            id: 'tu_2',
            input: { draft: 'done', word_count: 1 },
          },
        ],
      },
    ]);
    const exec = new ClaudeExecutor({ client });
    const { output } = await exec.execute(AGENT, {});
    expect(output.draft).toBe('done');
  });

  test('throws after exceeding max tool rounds without produce_output', async () => {
    const client = fakeClient([
      // Always a non-produce tool call → never terminates.
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'mystery_tool', id: 'x', input: {} }],
      },
    ]);
    const exec = new ClaudeExecutor({ client, maxToolRounds: 2 });
    await expect(exec.execute(AGENT, {})).rejects.toThrow(/Max tool rounds/);
  });

  test('reports token usage and computes cost from the pricing map', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        content: [
          {
            type: 'tool_use',
            name: 'produce_output',
            id: 'tu_1',
            input: { draft: 'hi', word_count: 1 },
          },
        ],
      },
    ]);
    const exec = new ClaudeExecutor({ client });
    const { metrics } = await exec.execute(AGENT, {});
    expect(metrics?.usage).toEqual({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    // AGENT.model is claude-sonnet-4-5 → $3/1M in + $15/1M out
    expect(metrics?.cost_usd).toBeCloseTo(18, 6);
    expect(metrics?.model).toBe('claude-sonnet-4-5');
  });

  test('computes cost for an ALIAS model when the resolved id is passed in', async () => {
    // "claude-sonnet" is a config alias, not a real model id. The resolver maps
    // it to "claude-sonnet-4-5"; the executor must use the resolved id for both
    // the API call and pricing — pricing off the raw alias yields undefined.
    const aliasAgent: AgentDef = { ...AGENT, model: 'claude-sonnet' };
    const resolved = resolveModel('claude-sonnet');
    expect(resolved.provider).toBe('claude');

    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        content: [
          {
            type: 'tool_use',
            name: 'produce_output',
            id: 'tu_1',
            input: { draft: 'hi', word_count: 1 },
          },
        ],
      },
    ]);
    const exec = new ClaudeExecutor({ client, model: resolved.model });
    const { metrics } = await exec.execute(aliasAgent, {});
    // Resolved id is used for pricing/metrics, not the alias.
    expect(metrics?.model).toBe(resolved.model);
    expect(metrics?.cost_usd).toBeDefined();
    // claude-sonnet-4-5: $3/1M in + $15/1M out
    expect(metrics?.cost_usd).toBeCloseTo(18, 6);
    // And the API call itself must use the resolved id.
    const createMock = client.messages.create as unknown as {
      mock: { calls: Array<[{ model: string }]> };
    };
    expect(createMock.mock.calls[0][0].model).toBe(resolved.model);
  });

  test('constructor throws without a client and without ANTHROPIC_API_KEY', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new ClaudeExecutor()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
