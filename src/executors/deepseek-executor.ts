import { OpenAICompatibleExecutor } from './openai-compatible-executor.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * Executor for DeepSeek's OpenAI-compatible chat API.
 *
 * Reads the key from `DEEPSEEK_API_KEY`. Example models: `deepseek-chat`
 * (V3) and `deepseek-reasoner` (R1).
 */
export class DeepSeekExecutor extends OpenAICompatibleExecutor {
  constructor(model: string) {
    super({
      model,
      baseUrl: DEEPSEEK_BASE_URL,
      providerLabel: 'DeepSeek',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    });
  }
}
