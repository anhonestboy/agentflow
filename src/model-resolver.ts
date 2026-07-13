import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type ModelConfig = {
  provider: 'claude' | 'ollama' | 'openrouter' | 'deepseek' | 'hermes' | 'agent-sdk';
  model: string;
  options?: Record<string, unknown>;
};

type ConfigFile = {
  models: Record<string, { provider: string; model?: string; options?: Record<string, unknown> }>;
  defaults?: { provider?: string; ollama_base_url?: string; num_ctx?: number };
};

let _config: ConfigFile | null = null;

const FALLBACK_CONFIG: ConfigFile = {
  models: {
    auto: { provider: 'auto' },
    'claude-sonnet': { provider: 'claude', model: 'claude-sonnet-4-5' },
    'claude-opus': { provider: 'claude', model: 'claude-opus-4-5' },
    'local-fast': {
      provider: 'ollama',
      model: 'qwen3.5:9b',
      options: { num_ctx: 2048 },
    },
    'local-smart': {
      provider: 'ollama',
      model: 'qwen2.5:14b',
      options: { num_ctx: 4096 },
    },
    'openrouter-smart': {
      provider: 'openrouter',
      model: 'google/gemini-2.5-pro',
    },
    'openrouter-free': {
      provider: 'openrouter',
      model: 'meta-llama/llama-3.3-8b-instruct:free',
    },
    'deepseek-chat': {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
    'deepseek-reasoner': {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    },
    hermes: { provider: 'hermes', model: 'hermes-agent' },
    'claude-plan': { provider: 'agent-sdk', model: 'claude-sonnet-4-5' },
  },
};

function loadConfig(): ConfigFile {
  if (_config) return _config;

  // Cerca in CWD, poi in AGENTFLOW_WORKFLOWS_DIR
  const candidates = ['agentflow.config.json'];
  const workflowsDir = process.env.AGENTFLOW_WORKFLOWS_DIR;
  if (workflowsDir) candidates.push(join(workflowsDir, 'agentflow.config.json'));

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        _config = JSON.parse(readFileSync(path, 'utf-8')) as ConfigFile;
        return _config;
      } catch {
        // file corrotto, prova il prossimo
      }
    }
  }

  _config = FALLBACK_CONFIG;
  return _config;
}

function resolveAuto(): ModelConfig {
  const config = loadConfig();

  // Rispetta provider esplicito se configurato
  const forced = process.env.AGENTFLOW_DEFAULT_PROVIDER?.trim();
  if (forced === 'openrouter' && process.env.OPENROUTER_API_KEY?.trim()) {
    const orSmart = config.models['openrouter-smart'];
    return {
      provider: 'openrouter',
      model: orSmart?.model ?? 'google/gemini-2.5-pro',
    };
  }
  if (forced === 'deepseek' && process.env.DEEPSEEK_API_KEY?.trim()) {
    const dsChat = config.models['deepseek-chat'];
    return {
      provider: 'deepseek',
      model: dsChat?.model ?? 'deepseek-chat',
    };
  }
  if (forced === 'ollama') {
    const localSmart = config.models['local-smart'];
    return localSmart?.model
      ? {
          provider: 'ollama',
          model: localSmart.model,
          options: localSmart.options,
        }
      : {
          provider: 'ollama',
          model: process.env.OLLAMA_MODEL ?? 'qwen2.5:14b',
          options: { num_ctx: 4096 },
        };
  }
  if (forced === 'hermes') {
    return { provider: 'hermes', model: 'hermes-agent' };
  }
  if (forced === 'claude' && process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-')) {
    return { provider: 'claude', model: 'claude-sonnet-4-5' };
  }

  // Autodetect: solo chiavi Anthropic reali (sk-ant-...) per evitare token di sessione
  if (process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-')) {
    return { provider: 'claude', model: 'claude-sonnet-4-5' };
  }
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    const orSmart = config.models['openrouter-smart'];
    return {
      provider: 'openrouter',
      model: orSmart?.model ?? 'google/gemini-2.5-pro',
    };
  }
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    const dsChat = config.models['deepseek-chat'];
    return {
      provider: 'deepseek',
      model: dsChat?.model ?? 'deepseek-chat',
    };
  }
  const localSmart = config.models['local-smart'];
  if (localSmart?.provider === 'ollama' && localSmart.model) {
    return {
      provider: 'ollama',
      model: localSmart.model,
      options: localSmart.options,
    };
  }
  return {
    provider: 'ollama',
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5:14b',
    options: { num_ctx: 4096 },
  };
}

export function resolveModel(agentModel?: string): ModelConfig {
  const config = loadConfig();
  const name = agentModel ?? 'auto';
  const entry = config.models[name];

  if (!entry || entry.provider === 'auto') {
    return resolveAuto();
  }

  return {
    provider: entry.provider as ModelConfig['provider'],
    model: entry.model ?? 'claude-sonnet-4-5',
    options: entry.options,
  };
}
