import Anthropic from '@anthropic-ai/sdk';
import type { AgentDef } from '../types.js';
import type { AgentExecutor, ExecutionContext } from '../runtime.js';
import type { ToolRegistry } from '../tools/index.js';
import { withRetry } from '../retry.js';
import { computeCostUsd } from '../pricing.js';
import { logger } from '../logger.js';
import type { TokenUsage } from '../types.js';

type MessageParam = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlock;
type ToolParam = Anthropic.Tool;

export type ClaudeExecutorOptions = {
  toolRegistry?: ToolRegistry;
  maxToolRounds?: number;
  /** Injectable client — primarily for testing. Defaults to a real Anthropic() instance. */
  client?: Anthropic;
  /**
   * Resolved model id (e.g. "claude-sonnet-4-5" from the config resolver).
   * `agent.model` is usually a config ALIAS (e.g. "claude-sonnet") — using it
   * raw would send an invalid id to the API and miss the pricing map. When
   * set, this wins over `agent.model` for both the API call and pricing.
   */
  model?: string;
};

export class ClaudeExecutor implements AgentExecutor {
  private client: Anthropic;
  private toolRegistry?: ToolRegistry;
  private maxToolRounds: number;
  private resolvedModel?: string;

  constructor(options?: ClaudeExecutorOptions) {
    if (options?.client) {
      this.client = options.client;
    } else {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not set');
      }
      this.client = new Anthropic();
    }
    this.toolRegistry = options?.toolRegistry;
    this.maxToolRounds =
      options?.maxToolRounds ?? (Number(process.env.AGENTFLOW_MAX_TOOL_ROUNDS) || 10);
    this.resolvedModel = options?.model;
  }

  async execute(
    agent: AgentDef,
    input: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<{
    output: Record<string, unknown>;
    metrics?: import('../types.js').ExecutionMetrics;
  }> {
    const system = this.buildSystemPrompt(agent, context);

    // Collect real tools for this agent
    const agentTools = this.toolRegistry ? this.toolRegistry.getForAgent(agent.tools ?? []) : [];

    // Build Claude tool params: real tools + produce_output
    const claudeTools: ToolParam[] = [
      ...agentTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as ToolParam['input_schema'],
      })),
      this.buildOutputTool(agent),
    ];

    const messages: MessageParam[] = [{ role: 'user', content: JSON.stringify(input, null, 2) }];

    // If agent has real tools, use auto mode so Claude can choose when to call them
    // Otherwise force tool call (produce_output must be called)
    const hasRealTools = agentTools.length > 0;
    let totalToolCalls = 0;

    // Prefer the resolved model id over the raw agent.model (config alias).
    const model = this.resolvedModel ?? agent.model ?? 'claude-opus-4-5';
    const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0 };
    let sawUsage = false;

    const buildMetrics = (): import('../types.js').ExecutionMetrics => {
      const u = sawUsage ? usage : undefined;
      return {
        tool_calls: totalToolCalls,
        model,
        usage: u,
        cost_usd: computeCostUsd(model, u),
      };
    };

    for (let round = 0; round < this.maxToolRounds; round++) {
      logger.debug(`[${agent.id}] Tool round ${round + 1}/${this.maxToolRounds}`);
      const response = await withRetry(
        () =>
          this.client.messages.create({
            model,
            max_tokens: 8096,
            system,
            messages,
            tools: claudeTools,
            tool_choice:
              hasRealTools && round === 0 ? { type: 'auto' as const } : { type: 'any' as const },
          }),
        `${agent.id}/claude-api`,
      );

      // Accumulate token usage across every round (input includes tool-result rounds).
      if (response.usage) {
        sawUsage = true;
        usage.prompt_tokens = (usage.prompt_tokens ?? 0) + (response.usage.input_tokens ?? 0);
        usage.completion_tokens =
          (usage.completion_tokens ?? 0) + (response.usage.output_tokens ?? 0);
      }

      // Check if produce_output was called
      const produceOutput = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'produce_output',
      );
      if (produceOutput) {
        return {
          output: produceOutput.input as Record<string, unknown>,
          metrics: buildMetrics(),
        };
      }

      // Collect all tool calls
      const toolCalls = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolCalls.length === 0) {
        // No tool calls — Claude responded with text only. Push it and ask again.
        if (response.stop_reason === 'end_turn') {
          // Force produce_output on next round
          messages.push({ role: 'assistant', content: response.content as ContentBlock[] });
          messages.push({
            role: 'user',
            content: 'Now call produce_output with all required fields.',
          });
          continue;
        }
        throw new Error(`[${agent.id}] Unexpected response without tool calls`);
      }

      totalToolCalls += toolCalls.length;

      // Execute tool calls and build results
      messages.push({ role: 'assistant', content: response.content as ContentBlock[] });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolCalls) {
        const tool = agentTools.find((t) => t.name === call.name);
        if (tool) {
          logger.info(`[${agent.id}] Calling tool: ${call.name}`);
          const result = await tool.execute(call.input as Record<string, unknown>);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    throw new Error(
      `[${agent.id}] Max tool rounds (${this.maxToolRounds}) exceeded without produce_output`,
    );
  }

  private buildSystemPrompt(agent: AgentDef, context?: ExecutionContext): string {
    const modeMap: Record<string, string> = {
      adversarial:
        'You are a critical reviewer. Your goal is to find bugs, issues, and weaknesses. You must not approve without concrete evidence that everything works.',
      focused: 'Focus exclusively on the task. No digressions.',
      reliable: 'Top priority: correctness and idempotency. No shortcuts.',
      precise: 'Exact output. No ambiguity. No superfluous text.',
      strict: 'Apply all rules without exceptions.',
      patient: 'Analyze carefully before responding.',
      objective: 'Evaluate facts without bias.',
    };

    const lines: string[] = [];

    if (modeMap[agent.mode]) lines.push(modeMap[agent.mode]);
    if (agent.constraints?.length)
      lines.push(`\nConstraints:\n${agent.constraints.map((c) => `- ${c}`).join('\n')}`);
    if (agent.rules?.length) lines.push(`\nRules:\n${agent.rules.map((r) => `- ${r}`).join('\n')}`);

    // Inform Claude about available tools
    if (agent.tools?.length) {
      lines.push(`\nYou have the following tools available: ${agent.tools.join(', ')}.`);
      lines.push('Use them as needed to complete the task.');
    }

    // Rollback directive: reverse the phase instead of repeating it
    if (context?.rollback) {
      lines.push(
        `\nROLLBACK MODE: You are UNDOING the effects of phase "${context.rollback.undoing}". ` +
          `Do NOT perform the original action again — reverse it (delete, deprovision, revert) and report what you undid.`,
      );
    }

    // Inject rules/context file content
    if (context?.injectedContext) {
      lines.push(`\n--- Project context ---\n${context.injectedContext}\n--- End context ---`);
    }

    // Inject loop context with acceptance criteria
    if (context?.loop) {
      const lc = context.loop;
      lines.push(
        `\nYou are in iteration ${lc.iteration} of a loop${lc.max_iterations ? ` (max ${lc.max_iterations})` : ''}.`,
      );
      if (lc.acceptance_criteria) {
        lines.push(`Workflow acceptance criteria: ${lc.acceptance_criteria}`);
        lines.push(
          'When these criteria are met, you may give "approved" with the appropriate confidence.',
        );
      }
    }

    lines.push('\nWhen you have completed the work, call produce_output with all required fields.');

    return lines.join('\n');
  }

  private buildOutputTool(agent: AgentDef): ToolParam {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const item of agent.must_produce ?? []) {
      const jsonType = this.toJsonType(item.type);
      properties[item.name] = { type: jsonType, description: `Required field: ${item.name}` };
      required.push(item.name);
    }

    return {
      name: 'produce_output',
      description: `Produce the required output for agent ${agent.id}. Call this tool AFTER completing the work.`,
      input_schema: {
        type: 'object' as const,
        properties,
        required,
      },
    };
  }

  private toJsonType(type?: string): string {
    switch (type) {
      case 'bool':
        return 'boolean';
      case 'float':
      case 'int':
        return 'number';
      case 'array':
        return 'array';
      case 'object':
        return 'object';
      default:
        return 'string';
    }
  }
}
