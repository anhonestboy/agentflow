import type { AgentDef, TokenUsage } from '../types.js';
import type { AgentExecutor, ExecutionContext } from '../runtime.js';
import { withRetry } from '../retry.js';
import { computeCostUsd } from '../pricing.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

/** Configuration for a provider exposing an OpenAI-compatible chat API. */
export type OpenAICompatibleConfig = {
  /** Model identifier forwarded to the provider. */
  model: string;
  /** Base URL — `/chat/completions` is appended to it. */
  baseUrl: string;
  /** Human-readable provider name, used in error messages and retry labels. */
  providerLabel: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnvVar: string;
  /** Extra headers merged into every request (e.g. attribution headers). */
  extraHeaders?: Record<string, string>;
  /**
   * When true, ask the provider to include cost accounting in `usage`
   * (OpenRouter: `usage: { include: true }` → response `usage.cost` in USD).
   */
  requestUsageAccounting?: boolean;
};

/** Usage/cost extracted from one chat-completion response. */
type UsageResult = { usage?: TokenUsage; cost?: number };

/**
 * Base executor for providers that expose an OpenAI-compatible
 * `POST /chat/completions` endpoint (OpenRouter, DeepSeek, …).
 *
 * Concrete providers only supply the base URL, the API key variable and the
 * label; all request/response handling — JSON extraction, truncation repair,
 * fuzzy field aliasing and output normalization — is shared here.
 */
export abstract class OpenAICompatibleExecutor implements AgentExecutor {
  protected readonly apiKey: string;
  protected readonly model: string;
  private readonly baseUrl: string;
  private readonly providerLabel: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly retrySlug: string;
  private readonly requestUsageAccounting: boolean;

  constructor(config: OpenAICompatibleConfig) {
    const key = process.env[config.apiKeyEnvVar]?.trim() ?? '';
    if (!key) {
      throw new Error(`${config.apiKeyEnvVar} is not set`);
    }
    this.apiKey = key;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.providerLabel = config.providerLabel;
    this.extraHeaders = config.extraHeaders ?? {};
    this.retrySlug = config.providerLabel.toLowerCase();
    this.requestUsageAccounting = config.requestUsageAccounting ?? false;
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

    const codeFields = (agent.must_produce ?? []).filter((i) => i.name === 'code');
    const textFields = (agent.must_produce ?? []).filter((i) => i.name !== 'code');

    const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0 };
    let sawUsage = false;
    let reportedCost: number | undefined;

    const json = await this.fetchJson(agent, system, input, textFields);
    const textOutput = json.output;
    sawUsage = this.mergeUsage(usage, json.usage) || sawUsage;
    reportedCost = this.addCost(reportedCost, json.cost);

    if (codeFields.length > 0) {
      const code = await this.fetchCode(agent, system, input);
      textOutput['code'] = code.code;
      sawUsage = this.mergeUsage(usage, code.usage) || sawUsage;
      reportedCost = this.addCost(reportedCost, code.cost);
    }

    // Prefer the provider's reported cost (OpenRouter usage accounting); otherwise
    // derive it from tokens via the static pricing map (undefined if model unknown).
    const cost = reportedCost ?? (sawUsage ? computeCostUsd(this.model, usage) : undefined);

    return {
      output: this.normalizeOutput(textOutput),
      metrics: {
        tool_calls: 0,
        model: this.model,
        usage: sawUsage ? usage : undefined,
        cost_usd: cost,
      },
    };
  }

  /** Fold one response's token usage into the running total. Returns true if any was present. */
  private mergeUsage(acc: TokenUsage, u: TokenUsage | undefined): boolean {
    if (!u) return false;
    acc.prompt_tokens = (acc.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0);
    acc.completion_tokens = (acc.completion_tokens ?? 0) + (u.completion_tokens ?? 0);
    return true;
  }

  private addCost(acc: number | undefined, add: number | undefined): number | undefined {
    if (add === undefined) return acc;
    return (acc ?? 0) + add;
  }

  /** Extract token usage and (optional) reported cost from a chat-completion response. */
  private extractUsage(data: {
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  }): UsageResult {
    if (!data.usage) return {};
    return {
      usage: {
        prompt_tokens: data.usage.prompt_tokens ?? 0,
        completion_tokens: data.usage.completion_tokens ?? 0,
      },
      cost: typeof data.usage.cost === 'number' ? data.usage.cost : undefined,
    };
  }

  private async fetchWithTimeout(body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`${this.providerLabel} ${response.status}: ${errBody.slice(0, 300)}`);
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
  ): Promise<{ output: Record<string, unknown>; usage?: TokenUsage; cost?: number }> {
    logger.debug(`[${agent.id}] fetchJson: ${fields.map((f) => f.name).join(', ')}`);

    const safeFields = fields.filter((f) => f.name !== 'code');
    const fieldList = safeFields.map((i) => `"${i.name}": "<${i.type ?? 'string'}>"`).join(',\n  ');

    const response = await withRetry(
      () =>
        this.fetchWithTimeout({
          model: this.model,
          max_tokens: 2048,
          response_format: { type: 'json_object' },
          ...(this.requestUsageAccounting ? { usage: { include: true } } : {}),
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `Input:\n${JSON.stringify(input, null, 2)}\n\nYou must produce EXACTLY these JSON fields, no more, no less:\n{\n  ${fieldList}\n}\n\nIMPORTANT: brief and concise values (max 100 characters per field). No additional text.`,
            },
          ],
        }),
      `${agent.id}/${this.retrySlug}-chat`,
    );

    logger.debug(`[${agent.id}] fetchJson response received`);

    const data = (await response.json()) as {
      choices?: Array<{ message: { content: string } }>;
      error?: { message: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const { usage, cost } = this.extractUsage(data);

    if (!data.choices) {
      logger.error(`[${agent.id}] unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
      throw new Error(
        `${this.providerLabel} response without choices: ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`,
      );
    }

    const content = data.choices[0]?.message?.content ?? '{}';

    // Extract the first valid JSON block from the content
    function extractJson(raw: string): string {
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

    // Repair truncated JSON (common when model output hits token limits)
    function repairTruncatedJson(raw: string): string {
      try {
        JSON.parse(raw);
        return raw;
      } catch {
        /* needs repair */
      }

      let result = raw;

      // Close unclosed string values (last " is start of value, no closing " or } after it)
      const lastQuote = result.lastIndexOf('"');
      const lastColon = result.lastIndexOf(':');
      if (lastQuote > lastColon) {
        const afterQuote = result.slice(lastQuote + 1);
        if (!afterQuote.includes('"') && !afterQuote.includes('}')) {
          result = result + '"';
        }
      }

      // Close unclosed braces
      let depth = 0;
      for (const ch of result) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      result += '}'.repeat(Math.max(0, depth));

      return result;
    }

    const rawJson = extractJson(content);
    try {
      const parsed = JSON.parse(rawJson);

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

      return { output: parsed, usage, cost };
    } catch {
      // Try repaired version before giving up
      try {
        const repaired = repairTruncatedJson(rawJson);
        const parsed = JSON.parse(repaired);
        logger.warn(`[${agent.id}] JSON was truncated — repaired automatically`);
        return { output: parsed, usage, cost };
      } catch {
        throw new Error(`[${agent.id}] Unparseable JSON:\n${content.slice(0, 200)}`);
      }
    }
  }

  private async fetchCode(
    agent: AgentDef,
    system: string,
    input: Record<string, unknown>,
  ): Promise<{ code: string; usage?: TokenUsage; cost?: number }> {
    logger.debug(`[${agent.id}] fetchCode...`);

    const response = await withRetry(
      () =>
        this.fetchWithTimeout({
          model: this.model,
          ...(this.requestUsageAccounting ? { usage: { include: true } } : {}),
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `Input:\n${JSON.stringify(input, null, 2)}\n\nRespond with a TypeScript code block:\n\`\`\`typescript\n// your code here\n\`\`\``,
            },
          ],
        }),
      `${agent.id}/${this.retrySlug}-code`,
    );

    logger.debug(`[${agent.id}] fetchCode response received`);

    const data = (await response.json()) as {
      choices?: Array<{ message: { content: string } }>;
      error?: { message: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const { usage, cost } = this.extractUsage(data);

    if (!data.choices) {
      logger.error(`[${agent.id}] unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
      throw new Error(
        `${this.providerLabel} response without choices: ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`,
      );
    }

    const content = data.choices[0]?.message?.content ?? '';

    const match = content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
    if (match) return { code: match[1].trim(), usage, cost };

    return {
      code: content
        .replace(/^```[\w]*\n?/, '')
        .replace(/\n?```$/, '')
        .trim(),
      usage,
      cost,
    };
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
    if (context?.rollback)
      lines.push(
        `ROLLBACK MODE: You are UNDOING the effects of phase "${context.rollback.undoing}". Do NOT repeat the original action — reverse it (delete, deprovision, revert) and report what you undid.`,
      );
    if (context?.injectedContext) lines.push(`Project context:\n${context.injectedContext}`);

    if (context?.loop) {
      const lc = context.loop;
      lines.push(
        `Iteration ${lc.iteration} of a loop${lc.max_iterations ? ` (max ${lc.max_iterations})` : ''}.`,
      );
      if (lc.acceptance_criteria) lines.push(`Acceptance criteria: ${lc.acceptance_criteria}`);
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
        const n = parseFloat(raw.replace(',', '.'));
        output['confidence'] = isNaN(n) ? 0.5 : Math.min(1, Math.max(0, n));
      } else if (typeof raw === 'number') {
        output['confidence'] = raw > 1 ? raw / 100 : raw;
      }
    }

    return output;
  }
}
