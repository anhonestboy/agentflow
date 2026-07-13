import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowRunner } from '../src/runtime.js';
import type { AgentExecutor, ExecutionContext } from '../src/runtime.js';
import { compileSource } from '../src/compiler.js';
import type { AgentDef } from '../src/types.js';

const WORKFLOW = (maxCost?: number) => `workflow budget_test
  ${maxCost !== undefined ? `max_cost: ${maxCost}` : ''}
  agents:
    agent a1
      model: "mock"
      must_produce:
        - r1

    agent a2
      model: "mock"
      must_produce:
        - r2

    agent a3
      model: "mock"
      must_produce:
        - r3

  phases:
    phase p1
      agent: a1
      input: [trigger.task]
      output: [r1]

    phase p2
      agent: a2
      input: [p1.r1]
      output: [r2]

    phase p3
      agent: a3
      input: [p2.r2]
      output: [r3]
`;

/** Each agent invocation costs a fixed amount. */
class CostExecutor implements AgentExecutor {
  constructor(private costPerCall: number) {}
  async execute(
    agent: AgentDef,
    _input: Record<string, unknown>,
    _context?: ExecutionContext,
  ): Promise<{
    output: Record<string, unknown>;
    metrics: { tool_calls: number; cost_usd: number };
  }> {
    const output: Record<string, unknown> = {};
    for (const item of agent.must_produce ?? []) output[item.name] = `mock-${item.name}`;
    return { output, metrics: { tool_calls: 0, cost_usd: this.costPerCall } };
  }
}

describe('Budget constraints (max_cost)', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aflow-budget-'));
    cwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test('aborts when accumulated cost exceeds max_cost', async () => {
    // 3 phases × $0.50 = $1.50; budget $0.80 → abort after p2 ($1.00 > $0.80)
    const ir = compileSource(WORKFLOW(0.8));
    const runner = new WorkflowRunner(ir, new CostExecutor(0.5), { outputDir: dir });

    const instance = await runner.run({ task: 'x' });

    expect(instance.state).toBe('failed');
    expect(instance.phase_states.p1).toBe('completed');
    expect(instance.phase_states.p2).toBe('completed'); // the phase that tipped the budget
    expect(instance.phase_states.p3).toBe('pending'); // never ran
    expect(instance.execution_receipt?.total_cost_usd).toBeCloseTo(1.0, 5);
    expect(instance.execution_receipt?.failed_steps.some((s) => s.phase_id === 'budget')).toBe(
      true,
    );
  });

  test('completes when total cost stays within budget', async () => {
    // 3 × $0.20 = $0.60 < $1.00
    const ir = compileSource(WORKFLOW(1.0));
    const runner = new WorkflowRunner(ir, new CostExecutor(0.2), { outputDir: dir });

    const instance = await runner.run({ task: 'x' });

    expect(instance.state).toBe('completed');
    expect(instance.phase_states.p3).toBe('completed');
    expect(instance.execution_receipt?.total_cost_usd).toBeCloseTo(0.6, 5);
  });

  test('no max_cost: cost is tracked but never aborts', async () => {
    const ir = compileSource(WORKFLOW(undefined));
    const runner = new WorkflowRunner(ir, new CostExecutor(5.0), { outputDir: dir });

    const instance = await runner.run({ task: 'x' });

    expect(instance.state).toBe('completed');
    expect(instance.execution_receipt?.total_cost_usd).toBeCloseTo(15.0, 5);
  });

  test('max_cost compiles into the IR', () => {
    const ir = compileSource(WORKFLOW(2.5));
    expect(ir.workflow.max_cost).toBe(2.5);
  });

  test('max_cost is enforced on validation retries (no unbounded retry spend)', async () => {
    // One phase whose output always fails schema validation, with retry: 3 and
    // $0.50/call. Budget $0.50: the initial call reaches the cap, the FIRST
    // retry exceeds it, and the remaining retries must NOT run.
    const SCHEMA_WORKFLOW = `workflow retry_budget
  max_cost: 0.5
  agents:
    agent writer
      model: "mock"
      must_produce:
        - summary
        - word_count: int
      output_schema:
        type: object
        properties:
          word_count:
            type: integer
            minimum: 10
        required:
          - word_count
      validation:
        retry: 3

  phases:
    phase write
      agent: writer
      input: [trigger.topic]
      output: [summary, word_count]
`;

    let calls = 0;
    const failingExecutor: AgentExecutor = {
      async execute() {
        calls++;
        // word_count 1 < minimum 10 → always fails validation
        return {
          output: { summary: 'x', word_count: 1 },
          metrics: { tool_calls: 0, cost_usd: 0.5 },
        };
      },
    };

    const ir = compileSource(SCHEMA_WORKFLOW);
    const runner = new WorkflowRunner(ir, failingExecutor, { outputDir: dir });
    const instance = await runner.run({ topic: 'x' });

    expect(instance.state).toBe('failed');
    expect(instance.execution_receipt?.failed_steps.some((s) => s.phase_id === 'budget')).toBe(
      true,
    );
    // initial call ($0.50) + exactly ONE retry ($0.50) — retries 2 and 3 skipped
    expect(calls).toBe(2);
    expect(instance.execution_receipt?.total_cost_usd).toBeCloseTo(1.0, 5);
  });
});
