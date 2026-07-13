import { describe, test, expect, afterEach } from '@jest/globals';
import { computeCostUsd, priceFor } from '../src/pricing.js';

describe('pricing', () => {
  const savedEnv = process.env.AGENTFLOW_PRICING_JSON;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGENTFLOW_PRICING_JSON;
    else process.env.AGENTFLOW_PRICING_JSON = savedEnv;
  });

  test('computes cost from tokens for a known Anthropic model', () => {
    // opus-tier: $5/1M input, $25/1M output
    const cost = computeCostUsd('claude-opus-4-5', {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(30, 6);
  });

  test('computes cost for a known DeepSeek model', () => {
    const cost = computeCostUsd('deepseek-chat', {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.27 + 1.1, 6);
  });

  test('unknown model → cost not counted (undefined)', () => {
    expect(
      computeCostUsd('some-unknown-model', { prompt_tokens: 100, completion_tokens: 50 }),
    ).toBe(undefined);
  });

  test('missing usage → undefined', () => {
    expect(computeCostUsd('claude-opus-4-5', undefined)).toBe(undefined);
  });

  test('AGENTFLOW_PRICING_JSON overrides and extends the static map', () => {
    process.env.AGENTFLOW_PRICING_JSON = JSON.stringify({
      'my-model': { input: 2, output: 8 },
      'claude-opus-4-5': { input: 1, output: 1 },
    });
    // new model now priced
    expect(
      computeCostUsd('my-model', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }),
    ).toBeCloseTo(10, 6);
    // override wins over the static value
    expect(priceFor('claude-opus-4-5')).toEqual({ input: 1, output: 1 });
  });

  test('invalid AGENTFLOW_PRICING_JSON is ignored (falls back to static map)', () => {
    process.env.AGENTFLOW_PRICING_JSON = '{not valid json';
    expect(priceFor('claude-sonnet-4-5')).toEqual({ input: 3, output: 15 });
  });
});
