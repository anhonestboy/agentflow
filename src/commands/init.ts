import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import 'dotenv/config';

type OllamaModel = { name: string; size: number };
type ORModel = { id: string; free: boolean; top: boolean; price: string };

// ── Ollama ───────────────────────────────────────────────────────────

async function detectOllamaModels(): Promise<OllamaModel[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return [];
    const data = (await res.json()) as { models: Array<{ name: string; size: number }> };
    return data.models.map((m) => ({ name: m.name, size: m.size }));
  } catch {
    return [];
  }
}

function formatSize(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function recommendModels(models: OllamaModel[], ramGb: number): { fast: string; smart: string } {
  const maxBytes = ramGb * 1e9 * 0.55;
  const fits = models.filter((m) => m.size < maxBytes).sort((a, b) => b.size - a.size);
  const smart = fits[0]?.name ?? models[0]?.name ?? 'qwen3:8b';
  const fast = models.filter((m) => m.size < 7e9).sort((a, b) => b.size - a.size)[0]?.name ?? smart;
  return { fast, smart };
}

function numCtxFromRam(ramGb: number): number {
  if (ramGb >= 64) return 16384;
  if (ramGb >= 32) return 8192;
  if (ramGb >= 16) return 4096;
  return 2048;
}

// ── OpenRouter ───────────────────────────────────────────────────────

const TOP_MODELS = new Set([
  'google/gemini-2.5-pro',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-5',
  'openai/gpt-4o',
  'qwen/qwen3-235b-a22b',
  'qwen/qwen3-30b-a3b',
  'qwen/qwen3-plus',
  'deepseek/deepseek-r2',
  'deepseek/deepseek-chat-v3-0324',
  'minimax/minimax-m1',
  'mistralai/mistral-large-2411',
  'x-ai/grok-3-beta',
]);

const STATIC_MODELS: ORModel[] = [
  { id: 'google/gemini-2.5-pro', free: false, top: true, price: '$1.25/1M' },
  { id: 'anthropic/claude-sonnet-4-5', free: false, top: true, price: '$3.00/1M' },
  { id: 'anthropic/claude-opus-4-5', free: false, top: true, price: '$15.0/1M' },
  { id: 'openai/gpt-4o', free: false, top: true, price: '$2.50/1M' },
  { id: 'qwen/qwen3-235b-a22b', free: false, top: true, price: '$0.45/1M' },
  { id: 'qwen/qwen3-30b-a3b', free: false, top: true, price: '$0.08/1M' },
  { id: 'qwen/qwen3-plus', free: false, top: true, price: '$0.15/1M' },
  { id: 'deepseek/deepseek-r2', free: false, top: true, price: '$0.55/1M' },
  { id: 'deepseek/deepseek-chat-v3-0324', free: false, top: true, price: '$0.20/1M' },
  { id: 'minimax/minimax-m1', free: false, top: true, price: '$0.40/1M' },
  { id: 'mistralai/mistral-large-2411', free: false, top: true, price: '$2.00/1M' },
  { id: 'x-ai/grok-3-beta', free: false, top: true, price: '$3.00/1M' },
  { id: 'meta-llama/llama-3.3-8b-instruct:free', free: true, top: false, price: 'free' },
  { id: 'qwen/qwen3-8b:free', free: true, top: false, price: 'free' },
  { id: 'deepseek/deepseek-r1:free', free: true, top: false, price: 'free' },
  { id: 'google/gemma-3-27b-it:free', free: true, top: false, price: 'free' },
  { id: 'mistralai/mistral-7b-instruct:free', free: true, top: false, price: 'free' },
];

async function fetchOpenRouterModels(apiKey?: string): Promise<ORModel[]> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      data: Array<{ id: string; pricing: { prompt: string }; name?: string }>;
    };

    return data.data
      .map((m) => {
        const pricePerToken = parseFloat(m.pricing.prompt);
        const free = pricePerToken === 0 || isNaN(pricePerToken);
        const pricePer1M = free ? 'free' : `$${(pricePerToken * 1_000_000).toFixed(2)}/1M`;
        return { id: m.id, free, top: TOP_MODELS.has(m.id), price: pricePer1M };
      })
      .sort((a, b) => {
        if (a.top && !b.top) return -1;
        if (!a.top && b.top) return 1;
        if (a.free && !b.free) return 1;
        if (!a.free && b.free) return -1;
        return a.id.localeCompare(b.id);
      });
  } catch {
    return [];
  }
}

function buildModelChoices(models: ORModel[], defaultId: string) {
  const topModels = models.filter((m) => m.top);
  const freeModels = models.filter((m) => m.free && !m.top);
  const otherModels = models.filter((m) => !m.top && !m.free);

  const toChoice = (m: ORModel) => ({
    name: `${m.id.padEnd(55)} ${m.free ? chalk.green('free') : chalk.dim(m.price)}`,
    value: m.id,
    short: m.id,
  });

  return [
    {
      name: chalk.bold('── 🧠 Frontier ──────────────────────────'),
      value: '__sep1__',
      disabled: true,
    },
    ...topModels.map(toChoice),
    {
      name: chalk.bold('── 🆓 Free ───────────────────────────────'),
      value: '__sep2__',
      disabled: true,
    },
    ...freeModels.map(toChoice),
    {
      name: chalk.bold('── 📦 Others ────────────────────────────'),
      value: '__sep3__',
      disabled: true,
    },
    ...otherModels.slice(0, 50).map(toChoice),
    {
      name: chalk.dim('── enter manually ───────────────────────'),
      value: '__custom__',
      short: 'custom',
    },
  ].filter((c) =>
    !('disabled' in c) || topModels.length + freeModels.length + otherModels.length > 0
      ? true
      : false,
  );
}

// ── Claude Code MCP registration ─────────────────────────────────────

function registerMcpServer(opts: {
  anthropicKey?: string;
  openrouterKey?: string;
  deepseekKey?: string;
  workflowsDir: string;
}): void {
  const defaultProvider = opts.openrouterKey
    ? 'openrouter'
    : opts.deepseekKey
      ? 'deepseek'
      : opts.anthropicKey
        ? 'claude'
        : 'ollama';

  // Remove existing registration if present (-s user = global)
  spawnSync('claude', ['mcp', 'remove', 'agentflow', '-s', 'user'], { stdio: 'ignore' });

  // Build -e KEY=VALUE as separate array entries (handles spaces in values)
  const envArgs: string[] = [
    '-e',
    `AGENTFLOW_WORKFLOWS_DIR=${opts.workflowsDir}`,
    '-e',
    `AGENTFLOW_DEFAULT_PROVIDER=${defaultProvider}`,
    '-e',
    'OLLAMA_BASE_URL=http://localhost:11434',
  ];
  if (opts.openrouterKey) envArgs.push('-e', `OPENROUTER_API_KEY=${opts.openrouterKey}`);
  if (opts.deepseekKey) envArgs.push('-e', `DEEPSEEK_API_KEY=${opts.deepseekKey}`);
  if (opts.anthropicKey) envArgs.push('-e', `ANTHROPIC_API_KEY=${opts.anthropicKey}`);

  // name before options, -s user = global scope
  const result = spawnSync(
    'claude',
    ['mcp', 'add', 'agentflow', '-s', 'user', ...envArgs, '--', 'agentflow-mcp'],
    { stdio: 'pipe', encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || 'claude mcp add failed');
  }
}

// ── .env helper ──────────────────────────────────────────────────────

function writeEnvKey(key: string, value: string): void {
  const envLine = `${key}=${value}\n`;
  if (existsSync('.env')) {
    const current = readFileSync('.env', 'utf-8');
    if (!current.includes(key)) appendFileSync('.env', envLine);
  } else {
    writeFileSync('.env', envLine);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

export async function runInit(): Promise<void> {
  // Load variables from existing .env first
  if (existsSync('.env')) {
    const envContent = readFileSync('.env', 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  }

  console.log(chalk.bold('\n🤖 AgentFlow — Initial setup\n'));

  // ── 1. Detect Ollama ─────────────────────────────────────────────
  process.stdout.write(chalk.dim('⠋ Detecting Ollama models...'));
  const ollamaModels = await detectOllamaModels();
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (ollamaModels.length === 0) {
    console.log(chalk.yellow('⚠️  Ollama not found or no models installed.'));
    console.log(chalk.dim('   → https://ollama.com  →  ollama pull qwen3:8b\n'));
  } else {
    console.log(chalk.green(`✅ Found ${ollamaModels.length} Ollama models:`));
    for (const m of ollamaModels) {
      console.log(`   • ${m.name.padEnd(28)} ${formatSize(m.size)}`);
    }
    console.log();
  }

  // ── 2. Provider ──────────────────────────────────────────────────
  const provider = await select({
    message: 'Default provider?',
    choices: [
      { name: 'ollama       — local, free', value: 'ollama' },
      { name: 'openrouter   — cloud, access to all models', value: 'openrouter' },
      { name: 'deepseek     — cloud, DeepSeek direct (deepseek-chat/reasoner)', value: 'deepseek' },
      { name: 'claude       — Anthropic direct', value: 'claude' },
      { name: 'auto         — cloud if API key present, otherwise Ollama', value: 'auto' },
    ],
  });

  // ── 3. API Keys ──────────────────────────────────────────────────
  let anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  let openrouterKey = process.env.OPENROUTER_API_KEY ?? '';
  let deepseekKey = process.env.DEEPSEEK_API_KEY ?? '';

  if (provider === 'claude' || provider === 'auto') {
    const existing = anthropicKey;
    const masked = existing ? `${existing.slice(0, 8)}...` : undefined;
    if (masked) console.log(chalk.dim(`   Existing key: ${masked}`));
    const k = await input({ message: 'ANTHROPIC_API_KEY', default: existing || undefined });
    if (k) anthropicKey = k;
  }

  if (provider === 'openrouter' || provider === 'auto') {
    const existing = openrouterKey;
    const masked = existing ? `${existing.slice(0, 8)}...` : undefined;
    if (masked) console.log(chalk.dim(`   Existing key: ${masked}`));
    const k = await input({
      message: 'OPENROUTER_API_KEY (https://openrouter.ai/keys)',
      default: existing || undefined,
    });
    if (k) openrouterKey = k;
  }

  if (provider === 'deepseek' || provider === 'auto') {
    const existing = deepseekKey;
    const masked = existing ? `${existing.slice(0, 8)}...` : undefined;
    if (masked) console.log(chalk.dim(`   Existing key: ${masked}`));
    const k = await input({
      message: 'DEEPSEEK_API_KEY (https://platform.deepseek.com/api_keys)',
      default: existing || undefined,
    });
    if (k) deepseekKey = k;
  }

  // ── 4. RAM ───────────────────────────────────────────────────────
  const ramStr = await select({
    message: 'Available RAM?',
    choices: [
      { name: '8 GB', value: '8' },
      { name: '16 GB', value: '16' },
      { name: '32 GB', value: '32' },
      { name: '64 GB', value: '64' },
    ],
    default: '16',
  });
  const ramGb = parseInt(ramStr);
  const numCtx = numCtxFromRam(ramGb);

  // ── 5. Ollama models ─────────────────────────────────────────────
  const { fast: ollamaFastDefault, smart: ollamaSmartDefault } = recommendModels(
    ollamaModels,
    ramGb,
  );

  let ollamaSmartModel = ollamaSmartDefault;
  let ollamaFastModel = ollamaFastDefault;

  if (ollamaModels.length > 0) {
    const ollamaChoices = [
      ...ollamaModels.map((m) => ({
        name: `${m.name.padEnd(30)} ${formatSize(m.size)}`,
        value: m.name,
        short: m.name,
      })),
      { name: chalk.dim('enter manually'), value: '__custom__', short: 'custom' },
    ];

    const smartSel = await select({
      message: 'Ollama smart model?',
      choices: ollamaChoices,
      default: ollamaSmartDefault,
    });
    if (smartSel === '__custom__') {
      ollamaSmartModel = await input({ message: 'Ollama smart model (e.g. qwen3:14b)' });
    } else {
      ollamaSmartModel = smartSel;
    }

    const fastSel = await select({
      message: 'Ollama fast model?',
      choices: ollamaChoices,
      default: ollamaFastDefault,
    });
    if (fastSel === '__custom__') {
      ollamaFastModel = await input({ message: 'Ollama fast model (e.g. qwen3:8b)' });
    } else {
      ollamaFastModel = fastSel;
    }
  }

  // ── 6. OpenRouter models ─────────────────────────────────────────
  let orSmartModel = 'google/gemini-2.5-pro';
  let orFreeModel = 'meta-llama/llama-3.3-8b-instruct:free';

  if (provider === 'openrouter' || openrouterKey) {
    process.stdout.write(chalk.dim('⠋ Loading OpenRouter models...'));
    const orModels = await fetchOpenRouterModels(openrouterKey);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    const list = orModels.length > 0 ? orModels : STATIC_MODELS;
    console.log(chalk.green(`✅ ${list.length} OpenRouter models available\n`));

    const smartChoices = buildModelChoices(list, orSmartModel);

    const smartSel = await select({
      message: 'OpenRouter smart model?',
      choices: smartChoices,
      pageSize: 20,
    });
    if (smartSel === '__custom__') {
      orSmartModel = await input({ message: 'Model ID (e.g. qwen/qwen3-235b-a22b)' });
    } else {
      orSmartModel = smartSel;
    }

    const freeSel = await select({
      message: 'OpenRouter free/fast model?',
      choices: smartChoices,
      pageSize: 20,
      default: orFreeModel,
    });
    if (freeSel === '__custom__') {
      orFreeModel = await input({ message: 'Model ID (e.g. qwen/qwen3-8b:free)' });
    } else {
      orFreeModel = freeSel;
    }
  }

  // ── 7. Confirm ───────────────────────────────────────────────────
  console.log(chalk.bold('\nConfiguration summary:'));
  console.log(`   Provider         → ${chalk.cyan(provider)}`);
  console.log(`   Ollama smart     → ${chalk.cyan(ollamaSmartModel)}  (num_ctx: ${numCtx})`);
  console.log(`   Ollama fast      → ${chalk.cyan(ollamaFastModel)}`);
  if (provider === 'openrouter' || openrouterKey) {
    console.log(`   OpenRouter smart → ${chalk.cyan(orSmartModel)}`);
    console.log(`   OpenRouter free  → ${chalk.cyan(orFreeModel)}`);
  }
  if (provider === 'deepseek' || deepseekKey) {
    console.log(`   DeepSeek chat    → ${chalk.cyan('deepseek-chat')}`);
    console.log(`   DeepSeek reason  → ${chalk.cyan('deepseek-reasoner')}`);
  }
  console.log();

  const ok = await confirm({ message: 'Confirm?', default: true });
  if (!ok) {
    console.log(chalk.yellow('\nSetup cancelled.'));
    return;
  }

  // ── 8. Write config ──────────────────────────────────────────────
  const config = {
    models: {
      auto: {
        provider,
        model:
          provider === 'openrouter'
            ? orSmartModel
            : provider === 'deepseek'
              ? 'deepseek-chat'
              : ollamaSmartModel,
      },
      'local-fast': {
        provider: 'ollama',
        model: ollamaFastModel,
        options: { num_ctx: numCtx, think: false, keep_alive: '10m' },
      },
      'local-smart': {
        provider: 'ollama',
        model: ollamaSmartModel,
        options: { num_ctx: numCtx, think: false, keep_alive: '10m' },
      },
      'openrouter-smart': { provider: 'openrouter', model: orSmartModel },
      'openrouter-free': { provider: 'openrouter', model: orFreeModel },
      'deepseek-chat': { provider: 'deepseek', model: 'deepseek-chat' },
      'deepseek-reasoner': { provider: 'deepseek', model: 'deepseek-reasoner' },
      'claude-sonnet': { provider: 'claude', model: 'claude-sonnet-4-5' },
      'claude-opus': { provider: 'claude', model: 'claude-opus-4-5' },
    },
    defaults: {
      provider,
      ollama_base_url: 'http://localhost:11434',
      ollama_keep_alive: '10m',
      timeout_ms: 300000,
      num_ctx: numCtx,
    },
  };

  writeFileSync('agentflow.config.json', JSON.stringify(config, null, 2));
  console.log(chalk.green('\n✅ agentflow.config.json saved'));

  // ── 9. .env ──────────────────────────────────────────────────────
  let envUpdated = false;
  if (anthropicKey) {
    writeEnvKey('ANTHROPIC_API_KEY', anthropicKey);
    envUpdated = true;
  }
  if (openrouterKey) {
    writeEnvKey('OPENROUTER_API_KEY', openrouterKey);
    envUpdated = true;
  }
  if (deepseekKey) {
    writeEnvKey('DEEPSEEK_API_KEY', deepseekKey);
    envUpdated = true;
  }
  if (envUpdated) console.log(chalk.green('✅ .env updated'));

  // ── 10. .gitignore ───────────────────────────────────────────────
  if (existsSync('.gitignore')) {
    const gi = readFileSync('.gitignore', 'utf-8');
    if (!gi.includes('.env')) appendFileSync('.gitignore', '\n.env\n');
  } else {
    writeFileSync('.gitignore', '.env\noutput/\n*.state.json\n');
  }
  console.log(chalk.green('✅ .gitignore updated'));

  // ── 11. Claude Code MCP setup ────────────────────────────────────
  const configureClaude = await confirm({
    message: 'Register AgentFlow as MCP server in Claude Code automatically?',
    default: true,
  });

  if (configureClaude) {
    try {
      registerMcpServer({
        anthropicKey: anthropicKey || undefined,
        openrouterKey: openrouterKey || undefined,
        deepseekKey: deepseekKey || undefined,
        workflowsDir: resolve(process.cwd()),
      });
      console.log(chalk.green('✅ AgentFlow registered in Claude Code (claude mcp add)'));
      console.log(chalk.dim('   Restart Claude Code to activate the MCP server.'));
    } catch {
      console.log(chalk.yellow('⚠️  Could not run "claude mcp add" automatically.'));
      console.log(chalk.dim('   Run manually: agentflow mcp-config'));
    }
  } else {
    console.log(chalk.dim('\n   To configure Claude Code manually, run: agentflow mcp-config'));
  }

  console.log(chalk.bold('\n🚀 Ready! Try:'));
  console.log(chalk.cyan(`   agentflow check examples/code-quality.aflow`));
  console.log(chalk.cyan(`   agentflow run examples/code-quality.aflow --input 'task="test"'\n`));
}
