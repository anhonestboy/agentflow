import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowRunner, MockAgentExecutor } from '../src/runtime.js';
import { compileSource } from '../src/compiler.js';

const WORKFLOW = `workflow sd_test
  agents:
    agent a
      model: "mock"
      must_produce:
        - r

  phases:
    phase p
      agent: a
      input: [trigger.x]
      output: [r]
`;

describe('AGENTFLOW state directory', () => {
  let cwdDir: string;
  let stateDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    cwdDir = mkdtempSync(join(tmpdir(), 'aflow-cwd-'));
    stateDir = mkdtempSync(join(tmpdir(), 'aflow-state-'));
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('writes <uuid>.state.json into stateDir, not the CWD', async () => {
    const ir = compileSource(WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor(), {
      stateDir,
      outputDir: join(stateDir, 'output'),
    });

    const instance = await runner.run({ x: 'hello' });
    expect(instance.state).toBe('completed');

    expect(existsSync(join(stateDir, `${instance.instance_id}.state.json`))).toBe(true);
    // The CWD must stay clean.
    const cwdStateFiles = readdirSync(cwdDir).filter((f) => f.endsWith('.state.json'));
    expect(cwdStateFiles).toEqual([]);
  });

  test('resume loads state from the configured stateDir', async () => {
    const ir = compileSource(WORKFLOW);
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const stateData = {
      instance_id: instanceId,
      workflow_id: 'sd_test',
      state: 'paused',
      trigger_input: { x: 'hi' },
      phase_states: { p: 'pending' },
      phase_outputs: {},
      loop_iterations: {},
    };
    // State lives ONLY in stateDir — not the CWD.
    writeFileSync(join(stateDir, `${instanceId}.state.json`), JSON.stringify(stateData));

    const runner = new WorkflowRunner(ir, new MockAgentExecutor(), {
      stateDir,
      outputDir: join(stateDir, 'output'),
    });
    const instance = await runner.resume(instanceId);

    expect(instance.state).toBe('completed');
    expect(instance.phase_states.p).toBe('completed');
  });

  test('default behavior (no stateDir) still writes to the CWD', async () => {
    const ir = compileSource(WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor(), {
      outputDir: join(cwdDir, 'output'),
    });
    const instance = await runner.run({ x: 'hi' });
    expect(existsSync(join(cwdDir, `${instance.instance_id}.state.json`))).toBe(true);
  });
});

describe('graceful shutdown wiring', () => {
  test('enableGracefulShutdown registers SIGINT and SIGTERM handlers', () => {
    const ir = compileSource(WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor(), {});
    const spy = jest.spyOn(process, 'once');
    try {
      runner.enableGracefulShutdown();
      const signals = spy.mock.calls.map((c) => c[0]);
      expect(signals).toContain('SIGINT');
      expect(signals).toContain('SIGTERM');
    } finally {
      spy.mockRestore();
      // Remove the handlers this test registered so it doesn't leak into others.
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    }
  });
});
