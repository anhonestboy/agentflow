import { OpenAICompatibleExecutor } from './openai-compatible-executor.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Executor for OpenRouter's OpenAI-compatible chat API. */
export class OpenRouterExecutor extends OpenAICompatibleExecutor {
  constructor(model: string) {
    super({
      model,
      baseUrl: OPENROUTER_BASE_URL,
      providerLabel: 'OpenRouter',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/anhonestboy/MCP-DSL',
        'X-Title': 'AgentFlow',
      },
    });
  }
}
