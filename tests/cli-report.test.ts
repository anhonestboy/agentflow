import { describe, test, expect } from '@jest/globals';
import {
  buildRunReport,
  usageTotals,
  formatCostLine,
  EXIT_COMPLETED,
  EXIT_FAILED,
  EXIT_PAUSED,
} from '../src/cli-report.js';
import type { WorkflowInstance, ExecutionReceipt } from '../src/types.js';

function instance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    instance_id: '11111111-1111-4111-8111-111111111111',
    workflow_id: 'wf',
    state: 'completed',
    trigger_input: {},
    phase_states: {},
    phase_outputs: {},
    loop_iterations: {},
    ...overrides,
  };
}

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    execution_log: [],
    tool_calls: {},
    side_effects: { files_written: [] },
    checkpoints: [],
    failed_steps: [],
    resumable: false,
    ...overrides,
  };
}

describe('buildRunReport — honest exit codes', () => {
  test('completed → exit 0', () => {
    const r = buildRunReport(instance({ state: 'completed' }), { file: 'w.aflow', command: 'run' });
    expect(r.exitCode).toBe(EXIT_COMPLETED);
    expect(r.lines.join(' ')).toMatch(/completed/i);
  });

  test('failed → exit 1 with failed_steps summary', () => {
    const inst = instance({
      state: 'failed',
      phase_states: { deploy: 'failed' },
      execution_receipt: receipt({
        failed_steps: [{ phase_id: 'deploy', error: 'boom' }],
      }),
    });
    const r = buildRunReport(inst, { file: 'w.aflow', command: 'run' });
    expect(r.exitCode).toBe(EXIT_FAILED);
    const text = r.lines.join('\n');
    expect(text).toMatch(/failed/i);
    expect(text).toContain('deploy');
    expect(text).toContain('boom');
  });

  test('paused at a gate → exit 2 with --approve-irreversible resume line', () => {
    const inst = instance({
      state: 'paused',
      phase_states: { build: 'completed', deploy: 'pending' },
      execution_receipt: receipt({
        resume_from_phase: 'deploy',
        execution_log: [{ phase_id: 'deploy', timestamp: 't', state: 'gated' }],
      }),
    });
    const r = buildRunReport(inst, { file: 'w.aflow', command: 'run' });
    expect(r.exitCode).toBe(EXIT_PAUSED);
    const text = r.lines.join('\n');
    expect(text).toContain('--approve-irreversible');
    expect(text).toContain(inst.instance_id);
    expect(text).toContain('deploy');
  });

  test('paused for human action → exit 2 without --approve-irreversible', () => {
    const inst = instance({
      state: 'paused',
      phase_states: { approve: 'awaiting_user' },
      execution_receipt: receipt({ resume_from_phase: 'approve' }),
    });
    const r = buildRunReport(inst, { file: 'w.aflow', command: 'run' });
    expect(r.exitCode).toBe(EXIT_PAUSED);
    const text = r.lines.join('\n');
    expect(text).toMatch(/human action/i);
    expect(text).not.toContain('--approve-irreversible');
    expect(text).toContain('agentflow resume');
  });

  test('paused by a signal (no gate marker) → exit 2, resume WITHOUT approval', () => {
    const inst = instance({
      state: 'paused',
      phase_states: { p1: 'completed', p2: 'pending' },
      execution_receipt: receipt({ resume_from_phase: 'p2' }),
    });
    const r = buildRunReport(inst, { file: 'w.aflow', command: 'run' });
    expect(r.exitCode).toBe(EXIT_PAUSED);
    const text = r.lines.join('\n');
    expect(text).toMatch(/interrupted/i);
    expect(text).not.toContain('--approve-irreversible');
    expect(text).toContain('agentflow resume');
  });

  test('unexpected terminal state → exit 1', () => {
    const r = buildRunReport(instance({ state: 'running' }), { file: 'w.aflow', command: 'run' });
    expect(r.exitCode).toBe(EXIT_FAILED);
  });
});

describe('cost reporting', () => {
  test('usageTotals sums per-phase usage and reads total_cost_usd', () => {
    const inst = instance({
      execution_receipt: receipt({
        total_cost_usd: 0.0123,
        usage: {
          a: { prompt_tokens: 100, completion_tokens: 40 },
          b: { prompt_tokens: 200, completion_tokens: 60 },
        },
      }),
    });
    const t = usageTotals(inst);
    expect(t.promptTokens).toBe(300);
    expect(t.completionTokens).toBe(100);
    expect(t.costUsd).toBeCloseTo(0.0123, 6);
    expect(t.costKnown).toBe(true);
  });

  test('cost unknown when no executor reported a dollar cost', () => {
    const inst = instance({
      execution_receipt: receipt({
        usage: { a: { prompt_tokens: 10, completion_tokens: 5 } },
      }),
    });
    const t = usageTotals(inst);
    expect(t.costKnown).toBe(false);
    expect(t.costUsd).toBe(0);
  });

  test('formatCostLine is stable and parseable', () => {
    const line = formatCostLine({
      costUsd: 0.0123,
      promptTokens: 300,
      completionTokens: 100,
      costKnown: true,
    });
    expect(line).toBe(
      'total_cost_usd=0.012300 total_prompt_tokens=300 total_completion_tokens=100 cost_known=true',
    );
  });
});
