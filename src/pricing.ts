import type { TokenUsage } from './types.js';
import { logger } from './logger.js';

/** Price of a model in USD per 1,000,000 tokens. */
export type ModelPrice = { input: number; output: number };

/**
 * Static pricing for the models AgentFlow ships in its default config, plus a
 * few common siblings. Values are USD per 1M tokens and are intentionally
 * coarse — the goal is an honest ballpark, not billing-grade precision.
 *
 * Override or extend at runtime with AGENTFLOW_PRICING_JSON, e.g.
 *   AGENTFLOW_PRICING_JSON='{"my-model":{"input":1.5,"output":6}}'
 *
 * Any model absent from both the override and this map has an UNKNOWN price:
 * its cost is NOT counted (cost_usd stays undefined), which is reported to the
 * user rather than silently guessed.
 */
const STATIC_PRICES: Record<string, ModelPrice> = {
  // Anthropic — Opus tier
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  // Anthropic — Sonnet tier
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 3, output: 15 },
  // Anthropic — Haiku tier
  'claude-haiku-4-5': { input: 1, output: 5 },
  // DeepSeek (native API list prices, cache-miss)
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
};

/** Parse AGENTFLOW_PRICING_JSON on every call (cheap; keeps env changes live for tests). */
function loadOverride(): Record<string, ModelPrice> {
  const raw = process.env.AGENTFLOW_PRICING_JSON?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    logger.warn('AGENTFLOW_PRICING_JSON is not valid JSON — ignoring the override');
  }
  return {};
}

/** Look up the price for a model. Override wins over the static map. */
export function priceFor(model: string): ModelPrice | undefined {
  return loadOverride()[model] ?? STATIC_PRICES[model];
}

/**
 * Compute the USD cost of a single agent invocation from its token usage.
 * Returns `undefined` when the model is unknown or usage is missing — the
 * caller must treat that as "cost not counted", never as zero.
 */
export function computeCostUsd(
  model: string | undefined,
  usage: TokenUsage | undefined,
): number | undefined {
  if (!model || !usage) return undefined;
  const price = priceFor(model);
  if (!price) return undefined;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  return (prompt / 1_000_000) * price.input + (completion / 1_000_000) * price.output;
}
