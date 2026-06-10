import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { WorkflowRunner, MockAgentExecutor } from '../src/runtime.js';

const SIMPLE = `
workflow simple_test
  description: "minimal"
  version: "1.0.0"

  agents:
    agent writer
      must_produce:
        - code
        - summary

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [code, summary]
`;

function ir() {
  return compile(parse(SIMPLE));
}

describe('loadState security guards', () => {
  let tempDir: string;
  let cwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aflow-state-'));
    cwd = process.cwd();
    process.chdir(tempDir);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects a non-UUID instance id (path-traversal guard)', async () => {
    const runner = new WorkflowRunner(ir(), new MockAgentExecutor());
    await expect(runner.resume('../../etc/passwd')).rejects.toThrow(/invalid instance id/i);
  });

  test('rejects a structurally invalid state file', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    // Valid UUID filename but the JSON is missing required fields / has bad state.
    writeFileSync(
      join(tempDir, `${id}.state.json`),
      JSON.stringify({ instance_id: id, state: 'bogus' }),
    );
    const runner = new WorkflowRunner(ir(), new MockAgentExecutor());
    await expect(runner.resume(id)).rejects.toThrow(/structural validation/i);
  });

  test('rejects a state file whose instance_id does not match the filename', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const other = '44444444-4444-4444-8444-444444444444';
    writeFileSync(
      join(tempDir, `${id}.state.json`),
      JSON.stringify({
        instance_id: other, // mismatch
        workflow_id: 'simple_test',
        state: 'failed',
        trigger_input: {},
        phase_states: {},
        phase_outputs: {},
        loop_iterations: {},
      }),
    );
    const runner = new WorkflowRunner(ir(), new MockAgentExecutor());
    await expect(runner.resume(id)).rejects.toThrow(/mismatch/i);
  });

  test('rejects corrupted (non-JSON) state', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    writeFileSync(join(tempDir, `${id}.state.json`), 'not json {{{');
    const runner = new WorkflowRunner(ir(), new MockAgentExecutor());
    await expect(runner.resume(id)).rejects.toThrow(/corrupted state/i);
  });
});
