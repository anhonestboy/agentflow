import { resolveModel } from '../src/model-resolver.js';

describe('resolveModel (fallback config + auto-detection)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // Start from a clean credential/provider environment for each test.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AGENTFLOW_DEFAULT_PROVIDER;
    delete process.env.OLLAMA_MODEL;
  });

  afterAll(() => {
    process.env = saved;
  });

  test('resolves a known alias to its provider/model', () => {
    expect(resolveModel('claude-sonnet')).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      options: undefined,
    });
  });

  test('resolves the agent-sdk alias', () => {
    const r = resolveModel('claude-plan');
    expect(r.provider).toBe('agent-sdk');
  });

  test('an unknown alias falls back to auto-detection', () => {
    // No credentials set → auto lands on local Ollama.
    const r = resolveModel('does-not-exist');
    expect(r.provider).toBe('ollama');
  });

  test('auto prefers a real Anthropic key (sk-ant-…) over OpenRouter', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-abc123';
    process.env.OPENROUTER_API_KEY = 'or-xyz';
    expect(resolveModel('auto').provider).toBe('claude');
  });

  test('auto ignores a non-sk-ant Anthropic token (session token)', () => {
    process.env.ANTHROPIC_API_KEY = 'session-token-not-a-key';
    process.env.OPENROUTER_API_KEY = 'or-xyz';
    // Falls through to OpenRouter since the Anthropic value is not a real key.
    expect(resolveModel('auto').provider).toBe('openrouter');
  });

  test('AGENTFLOW_DEFAULT_PROVIDER=ollama forces Ollama even with an Anthropic key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-abc123';
    process.env.AGENTFLOW_DEFAULT_PROVIDER = 'ollama';
    expect(resolveModel('auto').provider).toBe('ollama');
  });

  test('no alias argument defaults to auto', () => {
    expect(resolveModel().provider).toBe('ollama');
  });
});
