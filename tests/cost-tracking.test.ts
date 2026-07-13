import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowRunner } from '../src/runtime.js';
import type { AgentExecutor } from '../src/runtime.js';
import { compileSource } from '../src/compiler.js';
import type { AgentDef } from '../src/types.js';

const WORKFLOW = `workflow usage_test
  agents:
    agent a1
      model: "mock"
      must_produce:
        - r1
    agent a2
      model: "mock"
      must_produce:
        - r2

  phases:
    phase p1
      agent: a1
      input: [trigger.task]
      output: [r1]
    phase p2
      agent: a2
      input: [p1.r1]
      output: [r2]
`;

/** Executor that reports token usage + cost per call, like the real ones now do. */
class UsageExecutor implements AgentExecutor {
  async execute(agent: AgentDef) {
    const output: Record<string, unknown> = {};
    for (const item of agent.must_produce ?? []) output[item.name] = `mock-${item.name}`;
    return {
      output,
      metrics: {
        tool_calls: 0,
        model: 'claude-opus-4-5',
        usage: { prompt_tokens: 100, completion_tokens: 40 },
        cost_usd: 0.25,
      },
    };
  }
}

describe('per-phase usage + cost recording', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aflow-usage-'));
    cwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test('records token usage per phase and accumulates total cost', async () => {
    const ir = compileSource(WORKFLOW);
    const runner = new WorkflowRunner(ir, new UsageExecutor(), { outputDir: dir });
    const instance = await runner.run({ task: 'x' });

    expect(instance.state).toBe('completed');
    const receipt = instance.execution_receipt!;
    expect(receipt.usage?.p1).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      cost_usd: 0.25,
      model: 'claude-opus-4-5',
    });
    expect(receipt.usage?.p2?.prompt_tokens).toBe(100);
    // 2 phases × $0.25
    expect(receipt.total_cost_usd).toBeCloseTo(0.5, 6);
  });
});
