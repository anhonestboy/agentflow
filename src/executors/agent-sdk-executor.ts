import type { AgentDef, ExecutionMetrics } from '../types.js';
import type { AgentExecutor, ExecutionContext } from '../runtime.js';
import { withRetry } from '../retry.js';
import { logger } from '../logger.js';

/**
 * Minimal shape of the Agent SDK `query()` result messages we consume.
 * Kept local so the SDK remains an optional dependency.
 */
type SdkResultMessage = {
  type: string;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type AgentSdkQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<SdkResultMessage>;

/**
 * Executor backed by the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
 *
 * Unlike ClaudeExecutor (Anthropic SDK + ANTHROPIC_API_KEY, pay-as-you-go),
 * this executor authenticates through the local Claude Code login — so usage
 * draws from the subscription's monthly Agent SDK credit (Pro/Max/Team/
 * Enterprise) instead of API credits.
 *
 * Requirements: Claude Code installed and logged in (`claude login`).
 * The SDK package is an optional dependency:
 *   npm install @anthropic-ai/claude-agent-sdk
 */
export class AgentSdkExecutor implements AgentExecutor {
  private model: string;
  private queryFn?: AgentSdkQueryFn;

  constructor(model: string, queryFn?: AgentSdkQueryFn) {
    this.model = model;
    this.queryFn = queryFn;
  }

  async execute(
    agent: AgentDef,
    input: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<{ output: Record<string, unknown>; metrics?: ExecutionMetrics }> {
    logger.info(`Executing agent: ${agent.id} (provider: agent-sdk, mode: ${agent.mode})`);

    if (process.env.ANTHROPIC_API_KEY) {
      logger.warn(
        `[${agent.id}] ANTHROPIC_API_KEY is set — the Agent SDK gives it precedence over ` +
          `subscription auth. Unsetting it for this process so usage draws from the plan's ` +
          `monthly Agent SDK credit.`,
      );
      delete process.env.ANTHROPIC_API_KEY;
    }

    const query = await this.loadQueryFn(agent.id);
    const system = this.buildSystemPrompt(agent, context);
    const prompt = this.buildUserPrompt(agent, input);

    const message = await withRetry(
      () => this.runQuery(query, prompt, system),
      `${agent.id}/agent-sdk`,
    );

    if (message.total_cost_usd !== undefined) {
      logger.debug(
        `[${agent.id}] agent-sdk done — turns: ${message.num_turns ?? 1}, ` +
          `cost: $${message.total_cost_usd.toFixed(4)} (covered by subscription credit)`,
      );
    }

    const output = this.parseOutput(agent, message.result ?? '');
    const usage = message.usage
      ? {
          prompt_tokens: message.usage.input_tokens ?? 0,
          completion_tokens: message.usage.output_tokens ?? 0,
        }
      : undefined;
    return {
      output: this.normalizeOutput(output),
      metrics: { tool_calls: 0, cost_usd: message.total_cost_usd, usage, model: this.model },
    };
  }

  private async loadQueryFn(agentId: string): Promise<AgentSdkQueryFn> {
    if (this.queryFn) return this.queryFn;
    try {
      // Non-literal specifier: keeps the SDK an optional dependency (no compile-time resolution)
      const specifier = '@anthropic-ai/claude-agent-sdk';
      const mod = (await import(specifier)) as {
        query: AgentSdkQueryFn;
      };
      this.queryFn = mod.query;
      return this.queryFn;
    } catch {
      throw new Error(
        `[${agentId}] provider "agent-sdk" requires the Claude Agent SDK. ` +
          `Install it with: npm install @anthropic-ai/claude-agent-sdk ` +
          `(and make sure Claude Code is logged in: claude login)`,
      );
    }
  }

  private async runQuery(
    query: AgentSdkQueryFn,
    prompt: string,
    system: string,
  ): Promise<SdkResultMessage> {
    const iterator = query({
      prompt,
      options: {
        model: this.model,
        systemPrompt: system,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'default',
      },
    });

    for await (const message of iterator) {
      if (message.type === 'result') {
        if (message.subtype === 'success') return message;
        throw new Error(`Agent SDK result: ${message.subtype ?? 'unknown error'}`);
      }
    }
    throw new Error('Agent SDK stream ended without a result message');
  }

  private buildUserPrompt(agent: AgentDef, input: Record<string, unknown>): string {
    const fields = agent.must_produce ?? [];
    const fieldList = fields.map((i) => `"${i.name}": "<${i.type ?? 'string'}>"`).join(',\n  ');
    return (
      `Input:\n${JSON.stringify(input, null, 2)}\n\n` +
      `You must produce EXACTLY these JSON fields, no more, no less:\n{\n  ${fieldList}\n}\n\n` +
      `IMPORTANT: respond with valid JSON only. No additional text outside the JSON.`
    );
  }

  private buildSystemPrompt(agent: AgentDef, context?: ExecutionContext): string {
    const modeMap: Record<string, string> = {
      adversarial:
        'You are a critical reviewer. Find bugs and issues. Do not approve without concrete evidence.',
      focused: 'Focus only on the task. No digressions.',
      reliable: 'Priority: correctness. No shortcuts.',
      precise: 'Exact output. No ambiguity.',
      strict: 'Apply all rules without exceptions.',
      patient: 'Analyze carefully before responding.',
    };

    const lines: string[] = [];
    if (modeMap[agent.mode]) lines.push(modeMap[agent.mode]);
    if (agent.constraints?.length)
      lines.push(`Constraints:\n${agent.constraints.map((c) => `- ${c}`).join('\n')}`);
    if (agent.rules?.length) lines.push(`Rules:\n${agent.rules.map((r) => `- ${r}`).join('\n')}`);
    if (context?.injectedContext) lines.push(`Project context:\n${context.injectedContext}`);

    if (context?.loop) {
      const lc = context.loop;
      lines.push(
        `Iteration ${lc.iteration} of a loop${lc.max_iterations ? ` (max ${lc.max_iterations})` : ''}.`,
      );
      if (lc.acceptance_criteria) lines.push(`Acceptance criteria: ${lc.acceptance_criteria}`);
    }

    lines.push('ALWAYS respond with valid JSON only. No additional text.');
    return lines.join('\n');
  }

  private parseOutput(agent: AgentDef, raw: string): Record<string, unknown> {
    if (!raw.includes('{')) {
      throw new Error(`[${agent.id}] Agent SDK returned unparseable JSON:\n${raw.slice(0, 200)}`);
    }
    const json = this.extractJson(raw);
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      throw new Error(`[${agent.id}] Agent SDK returned unparseable JSON:\n${raw.slice(0, 200)}`);
    }
  }

  private extractJson(raw: string): string {
    const fenced = raw.match(/```json\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();

    const start = raw.indexOf('{');
    if (start === -1) return '{}';

    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') {
        depth--;
        if (depth === 0) return raw.slice(start, i + 1);
      }
    }
    return raw.slice(start);
  }

  private normalizeOutput(output: Record<string, unknown>): Record<string, unknown> {
    if (typeof output['verdict'] === 'string') {
      const v = output['verdict'].toLowerCase().replace(/\s+/g, '_');
      output['verdict'] = v.includes('approv') ? 'approved' : 'needs_work';
    }

    if (output['confidence'] !== undefined) {
      const raw = output['confidence'];
      const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : (raw as number);
      if (typeof n === 'number' && !isNaN(n)) {
        // Values above 1 are treated as percentages (e.g. 85 → 0.85)
        output['confidence'] = Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
      } else {
        output['confidence'] = 0.5;
      }
    }

    return output;
  }
}
