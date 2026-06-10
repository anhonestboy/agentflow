import { jest, describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import { ClaudeExecutor } from '../src/executors/claude-executor.js';
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
