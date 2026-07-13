import type { AgentDef, TokenUsage } from '../types.js';
import type { AgentExecutor, ExecutionContext } from '../runtime.js';
import type { ModelConfig } from '../model-resolver.js';
import { withRetry } from '../retry.js';
import { logger } from '../logger.js';

/** Ollama's non-streaming chat response shape (subset we consume). */
type OllamaChatResponse = {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
};

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3:30b';
const OLLAMA_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class OllamaExecutor implements AgentExecutor {
  private model: string;

  constructor(modelConfig?: ModelConfig) {
    this.model = modelConfig?.model ?? OLLAMA_MODEL;
  }

  async execute(
    agent: AgentDef,
    input: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<{
    output: Record<string, unknown>;
    metrics?: import('../types.js').ExecutionMetrics;
  }> {
    logger.info(`Executing agent: ${agent.id} (model: ${this.model}, mode: ${agent.mode})`);
    const system = this.buildSystemPrompt(agent, context);

    // Separate code fields from the rest
    const codeFields = (agent.must_produce ?? []).filter((i) => i.name === 'code');
    const textFields = (agent.must_produce ?? []).filter((i) => i.name !== 'code');

    const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0 };
    let sawUsage = false;

    const json = await this.fetchJson(agent, system, input, textFields);
    const textOutput = json.output;
    sawUsage = this.addUsage(usage, json.usage) || sawUsage;

    if (codeFields.length > 0) {
      const code = await this.fetchCode(agent, system, input);
      textOutput['code'] = code.code;
      sawUsage = this.addUsage(usage, code.usage) || sawUsage;
    }

    // Ollama runs locally — tokens are recorded, but there is no dollar cost to count.
    return {
      output: this.normalizeOutput(textOutput),
      metrics: {
        tool_calls: 0,
        model: this.model,
        usage: sawUsage ? usage : undefined,
      },
    };
  }

  /** Fold one response's token usage into the running total. Returns true if any was present. */
  private addUsage(acc: TokenUsage, data: OllamaChatResponse): boolean {
    if (data.prompt_eval_count === undefined && data.eval_count === undefined) return false;
    acc.prompt_tokens = (acc.prompt_tokens ?? 0) + (data.prompt_eval_count ?? 0);
    acc.completion_tokens = (acc.completion_tokens ?? 0) + (data.eval_count ?? 0);
    return true;
  }

  private async fetchWithTimeout(url: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // Throw so JSON.parse(undefined) can never happen downstream, and so
        // withRetry can retry transient 5xx/timeout failures.
        const errBody = await response.text().catch(() => '');
        throw new Error(`Ollama ${response.status}: ${errBody.slice(0, 300)}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJson(
    agent: AgentDef,
    system: string,
    input: Record<string, unknown>,
    fields: Array<{ name: string; type?: string }>,
  ): Promise<{ output: Record<string, unknown>; usage: OllamaChatResponse }> {
    logger.debug(`[${agent.id}] fetchJson: ${fields.map((f) => f.name).join(', ')}`);

    const safeFields = fields.filter((f) => f.name !== 'code');
    const fieldList = safeFields.map((i) => `"${i.name}": "<${i.type ?? 'string'}>"`).join(',\n  ');

    const data = await withRetry(
      () =>
        this.fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
          model: this.model,
          stream: false,
          format: 'json',
          keep_alive: '10m',
          options: { temperature: 0, think: false, num_ctx: 4096 },
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `Input:\n${JSON.stringify(input, null, 2)}\n\nRespond with JSON containing these fields:\n{\n  ${fieldList}\n}\n\nNOTE: verdict must be EXACTLY "approved" or "needs_work"`,
            },
          ],
        }).then((r) => r.json() as Promise<OllamaChatResponse>),
      `${agent.id}/ollama-chat`,
    );

    logger.debug(`[${agent.id}] fetchJson response received`);

    const content = data.message?.content ?? '';

    try {
      const parsed = JSON.parse(content);
      logger.debug(`[${agent.id}] fields received: ${Object.keys(parsed).join(', ')}`);

      // Fuzzy normalization of missing fields
      const aliases: Record<string, string[]> = {
        test_results: ['results', 'tests', 'test_output', 'testing_results', 'testResults'],
        edge_cases_tried: [
          'edge_cases',
          'edgeCases',
          'edge_case_tried',
          'cases_tried',
          'edgeCasesTried',
        ],
        bug_report: ['bugs', 'bug_reports', 'issues', 'bugReport', 'bugs_found'],
        user_story: ['story', 'userStory', 'user_stories'],
        progress_note: ['progress', 'note', 'notes', 'progressNote'],
        improvement_list: ['improvements', 'improvementList', 'suggestions', 'feedback'],
      };

      for (const [canonical, alts] of Object.entries(aliases)) {
        if (!(canonical in parsed)) {
          for (const alt of alts) {
            if (alt in parsed) {
              parsed[canonical] = parsed[alt];
              break;
            }
          }
        }
      }

      return { output: parsed, usage: data };
    } catch {
      throw new Error(`[${agent.id}] Unparseable JSON:\n${content.slice(0, 200)}`);
    }
  }

  private async fetchCode(
    agent: AgentDef,
    system: string,
    input: Record<string, unknown>,
  ): Promise<{ code: string; usage: OllamaChatResponse }> {
    logger.debug(`[${agent.id}] fetchCode...`);

    const data = await withRetry(
      () =>
        this.fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
          model: this.model,
          stream: false,
          keep_alive: '10m',
          options: { temperature: 0, think: false, num_ctx: 4096 },
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `Input:\n${JSON.stringify(input, null, 2)}\n\nRespond with a TypeScript code block:\n\`\`\`typescript\n// your code here\n\`\`\``,
            },
          ],
        }).then((r) => r.json() as Promise<OllamaChatResponse>),
      `${agent.id}/ollama-code`,
    );

    logger.debug(`[${agent.id}] fetchCode response received`);

    const content = data.message?.content ?? '';

    // Extract ```typescript ... ``` or ``` ... ``` block
    const match = content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
    if (match) return { code: match[1].trim(), usage: data };

    // Fallback: manual cleanup
    return {
      code: content
        .replace(/^```[\w]*\n?/, '')
        .replace(/\n?```$/, '')
        .trim(),
      usage: data,
    };
  }

  private buildSystemPrompt(agent: AgentDef, context?: ExecutionContext): string {
    const modeMap: Record<string, string> = {
      adversarial:
        'You are a critical reviewer. Find bugs and issues. Do not approve without evidence.',
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

    if (context?.rollback) {
      lines.push(
        `ROLLBACK MODE: You are UNDOING the effects of phase "${context.rollback.undoing}". Do NOT repeat the original action — reverse it (delete, deprovision, revert) and report what you undid.`,
      );
    }

    if (context?.injectedContext) {
      lines.push(`Project context:\n${context.injectedContext}`);
    }

    if (context?.loop) {
      const lc = context.loop;
      lines.push(
        `Iteration ${lc.iteration} of a loop${lc.max_iterations ? ` (max ${lc.max_iterations})` : ''}.`,
      );
      if (lc.acceptance_criteria) {
        lines.push(`Acceptance criteria: ${lc.acceptance_criteria}`);
      }
    }

    lines.push('ALWAYS respond with valid JSON only. No additional text.');
    if (agent.must_produce?.length) {
      const required = agent.must_produce
        .filter((f) => f.name !== 'code')
        .map((f) => `"${f.name}"`)
        .join(', ');
      if (required)
        lines.push(
          `You MUST produce these fields: ${required}. Do NOT include "code" fields in the JSON — code is requested separately.`,
        );
    }
    return lines.join('\n');
  }

  private normalizeOutput(output: Record<string, unknown>): Record<string, unknown> {
    if (typeof output['verdict'] === 'string') {
      const v = output['verdict'].toLowerCase().replace(/\s+/g, '_');
      output['verdict'] = v.includes('approv') ? 'approved' : 'needs_work';
    }

    if (output['confidence'] !== undefined) {
      const raw = output['confidence'];
      if (typeof raw === 'string') {
        const normalized = raw.replace(',', '.').trim();
        const parsed = parseFloat(normalized);
        if (!isNaN(parsed)) {
          output['confidence'] = Math.min(1, Math.max(0, parsed));
        } else {
          const wordMap: Record<string, number> = {
            alta: 0.9,
            alto: 0.9,
            high: 0.9,
            media: 0.6,
            medio: 0.6,
            medium: 0.6,
            bassa: 0.3,
            basso: 0.3,
            low: 0.3,
          };
          output['confidence'] = wordMap[normalized.toLowerCase()] ?? 0.5;
        }
      } else if (typeof raw === 'number') {
        output['confidence'] = raw > 1 ? raw / 100 : raw;
      }
    }

    return output;
  }
}
