import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowRunner, MockAgentExecutor } from '../src/runtime.js';
import { compileSource } from '../src/compiler.js';

// ─── Helpers ───────────────────────────────────────────────────────

const SIMPLE_WORKFLOW = `workflow simple_test
  agents:
    agent writer
      model: "mock"
      mode: focused
      must_produce:
        - code
        - summary

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [code, summary]
`;

const LOOP_WORKFLOW = `workflow loop_test
  agents:
    agent writer
      model: "mock"
      mode: focused
      must_produce:
        - code
        - progress_note

    agent critic
      model: "mock"
      mode: adversarial
      must_produce:
        - verdict
        - improvement_list
        - confidence: float

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [code, progress_note]

    phase review
      agent: critic
      input: [write.code]
      output: [verdict, improvement_list, confidence]

  loop quality_gate
    phases: [write, review]
    repeat_while: review.verdict == "needs_work"
    max_iterations: 5
    on_each_iteration:
      send_to: writer
      payload: review.improvement_list
`;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agentflow-test-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

// ─── Basic Run ─────────────────────────────────────────────────────

describe('WorkflowRunner — basic run', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('esegue workflow semplice e ritorna completed', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    const instance = await runner.run({ task: 'test task' });

    expect(instance.state).toBe('completed');
    expect(instance.phase_states['write']).toBe('completed');
    expect(instance.phase_outputs['write']).toBeDefined();
    expect(instance.phase_outputs['write']['code']).toBeDefined();
    expect(instance.phase_outputs['write']['summary']).toBeDefined();
  });

  test('esegue workflow con loop e completa dopo 2 iterazioni', async () => {
    const ir = compileSource(LOOP_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    const instance = await runner.run({ task: 'test task' });

    expect(instance.state).toBe('completed');
    expect(instance.loop_iterations['quality_gate']).toBe(2);
    expect(instance.phase_states['write']).toBe('completed');
    expect(instance.phase_states['review']).toBe('completed');
  });
});

// ─── Incremental State Save ────────────────────────────────────────

describe('WorkflowRunner — incremental state saving', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('salva .state.json dopo ogni fase', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    const instance = await runner.run({ task: 'test' });

    const stateFile = join(tempDir, `${instance.instance_id}.state.json`);
    expect(existsSync(stateFile)).toBe(true);

    const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(saved.state).toBe('completed');
    expect(saved.phase_states['write']).toBe('completed');
    expect(saved.completed_at).toBeDefined();
  });

  test('riempie default se must_produce manca invece di fallire', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);

    // Executor che non produce nulla
    const badExecutor = {
      execute: async () => ({ output: {} }),
    };

    const runner = new WorkflowRunner(ir, badExecutor);

    // Non deve più lanciare errore — riempie i default
    const instance = await runner.run({ task: 'test' });

    // Il workflow completa con campi default
    expect(instance.state).toBe('completed');
    expect(instance.phase_states['write']).toBe('completed');
    // I campi must_produce mancanti sono riempiti con default (stringa vuota)
    expect(instance.phase_outputs['write']).toEqual({ code: '', summary: '' });

    // Il .state.json deve esistere
    const files = readdirSync(tempDir) as string[];
    const stateFile = files.find((f: string) => f.endsWith('.state.json'));
    expect(stateFile).toBeDefined();

    const saved = JSON.parse(readFileSync(join(tempDir, stateFile!), 'utf-8'));
    expect(saved.state).toBe('completed');
    expect(saved.phase_states['write']).toBe('completed');
  });
});

// ─── Resume ────────────────────────────────────────────────────────

describe('WorkflowRunner — resume', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('resume salta fasi gia completed', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);

    // Creiamo uno stato con la fase "write" gia completata
    const instanceId = '11111111-1111-4111-8111-111111111001';
    const stateData = {
      instance_id: instanceId,
      workflow_id: 'simple_test',
      state: 'failed',
      trigger_input: { task: 'test' },
      phase_states: { write: 'completed' },
      phase_outputs: {
        write: { code: 'const x = 1;', summary: 'done' },
      },
      loop_iterations: {},
      loop_feedback: {},
      started_at: new Date().toISOString(),
    };
    writeFileSync(join(tempDir, `${instanceId}.state.json`), JSON.stringify(stateData));

    // Executor che traccia quante volte viene chiamato
    let executionCount = 0;
    const trackingExecutor = {
      execute: async () => {
        executionCount++;
        return { output: { code: 'const y = 2;', summary: 'resumed' } };
      },
    };

    const runner = new WorkflowRunner(ir, trackingExecutor);
    const instance = await runner.resume(instanceId);

    // La fase "write" era gia completed → l'executor non dovrebbe essere stato chiamato
    expect(executionCount).toBe(0);
    expect(instance.state).toBe('completed');
    expect(instance.phase_outputs['write']['code']).toBe('const x = 1;');
  });

  test('resume ri-esegue fasi failed', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);

    const instanceId = '11111111-1111-4111-8111-111111111002';
    const stateData = {
      instance_id: instanceId,
      workflow_id: 'simple_test',
      state: 'failed',
      trigger_input: { task: 'test' },
      phase_states: { write: 'failed' },
      phase_outputs: {},
      loop_iterations: {},
      loop_feedback: {},
      started_at: new Date().toISOString(),
    };
    writeFileSync(join(tempDir, `${instanceId}.state.json`), JSON.stringify(stateData));

    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    const instance = await runner.resume(instanceId);

    expect(instance.state).toBe('completed');
    expect(instance.phase_states['write']).toBe('completed');
    expect(instance.phase_outputs['write']['code']).toBeDefined();
  });

  test('resume lancia errore se workflow_id non corrisponde', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);

    const instanceId = '11111111-1111-4111-8111-1111111110a1';
    const stateData = {
      instance_id: instanceId,
      workflow_id: 'wrong_workflow',
      state: 'failed',
      trigger_input: {},
      phase_states: {},
      phase_outputs: {},
      loop_iterations: {},
      loop_feedback: {},
    };
    writeFileSync(join(tempDir, `${instanceId}.state.json`), JSON.stringify(stateData));

    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    await expect(runner.resume(instanceId)).rejects.toThrow('workflow_id mismatch');
  });

  test('resume lancia errore se istanza gia completed', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);

    const instanceId = '11111111-1111-4111-8111-1111111110d0';
    const stateData = {
      instance_id: instanceId,
      workflow_id: 'simple_test',
      state: 'completed',
      trigger_input: {},
      phase_states: { write: 'completed' },
      phase_outputs: { write: { code: 'x', summary: 'y' } },
      loop_iterations: {},
      loop_feedback: {},
    };
    writeFileSync(join(tempDir, `${instanceId}.state.json`), JSON.stringify(stateData));

    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    await expect(runner.resume(instanceId)).rejects.toThrow('already completed');
  });

  test('resume lancia errore se state file non esiste', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    await expect(runner.resume('11111111-1111-4111-8111-1111111110ff')).rejects.toThrow(
      'state file not found',
    );
  });
});

// ─── Resume with Loop ──────────────────────────────────────────────

describe('WorkflowRunner — resume mid-loop', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('resume a meta di un loop salta fasi completed nell iterazione corrente', async () => {
    const ir = compileSource(LOOP_WORKFLOW);

    const instanceId = '11111111-1111-4111-8111-1111111110c0';

    // Stato: iterazione 1, write completed ma review failed
    const stateData = {
      instance_id: instanceId,
      workflow_id: 'loop_test',
      state: 'failed',
      trigger_input: { task: 'test' },
      phase_states: { write: 'completed', review: 'failed' },
      phase_outputs: {
        write: { code: 'const x = 1;', progress_note: 'draft' },
      },
      loop_iterations: { quality_gate: 1 },
      loop_feedback: {},
      started_at: new Date().toISOString(),
    };
    writeFileSync(join(tempDir, `${instanceId}.state.json`), JSON.stringify(stateData));

    // Tracciamo le chiamate per capire cosa viene eseguito
    const calls: string[] = [];
    let callCount = 0;
    const trackingExecutor = {
      execute: async (agent: { id: string; must_produce?: { name: string; type?: string }[] }) => {
        calls.push(agent.id);
        callCount++;
        const output: Record<string, unknown> = {};
        if (agent.must_produce) {
          for (const item of agent.must_produce) {
            if (item.name === 'verdict') {
              output[item.name] = callCount >= 2 ? 'approved' : 'needs_work';
            } else if (item.name === 'confidence') {
              output[item.name] = callCount >= 2 ? 0.9 : 0.5;
            } else {
              output[item.name] = 'mock_value';
            }
          }
        }
        return { output };
      },
    };

    const runner = new WorkflowRunner(ir, trackingExecutor);
    const instance = await runner.resume(instanceId);

    // Nella prima iterazione (resume), write era completed → solo review deve essere eseguito
    // Poi se review dice needs_work, un'altra iterazione con write + review
    expect(calls[0]).toBe('critic'); // review nella iterazione 1 (resume)
    expect(instance.state).toBe('completed');
  });

  test('resume preserva loop_iterations count', async () => {
    const ir = compileSource(LOOP_WORKFLOW);

    const instanceId = '11111111-1111-4111-8111-1111111110c1';
    const stateData = {
      instance_id: instanceId,
      workflow_id: 'loop_test',
      state: 'failed',
      trigger_input: { task: 'test' },
      phase_states: { write: 'completed', review: 'completed' },
      phase_outputs: {
        write: { code: 'v1', progress_note: 'ok' },
        review: { verdict: 'needs_work', improvement_list: 'fix bugs', confidence: 0.5 },
      },
      loop_iterations: { quality_gate: 1 },
      loop_feedback: {},
      started_at: new Date().toISOString(),
    };
    writeFileSync(join(tempDir, `${instanceId}.state.json`), JSON.stringify(stateData));

    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    const instance = await runner.resume(instanceId);

    // MockAgentExecutor dara approved alla iterazione 2
    expect(instance.state).toBe('completed');
    expect(instance.loop_iterations['quality_gate']).toBeGreaterThanOrEqual(2);
  });
});

// ─── Output to Disk ────────────────────────────────────────────────

describe('WorkflowRunner — output to disk', () => {
  let tempDir: string;
  let outputDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    outputDir = join(tempDir, 'output');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('scrive phase output come JSON per ogni fase', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor(), { outputDir });
    await runner.run({ task: 'test' });

    const writeJson = join(outputDir, 'write.json');
    expect(existsSync(writeJson)).toBe(true);

    const output = JSON.parse(readFileSync(writeJson, 'utf-8'));
    expect(output.code).toBeDefined();
    expect(output.summary).toBeDefined();
  });

  test('estrae campo "code" come file .ts separato', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);

    // Executor che produce codice reale nel campo "code"
    const codeExecutor = {
      execute: async () => ({
        output: {
          code: 'export function hello() { return "world"; }',
          summary: 'implemented hello function',
        },
      }),
    };

    const runner = new WorkflowRunner(ir, codeExecutor, { outputDir });
    await runner.run({ task: 'test' });

    const codeFile = join(outputDir, 'write.code.ts');
    expect(existsSync(codeFile)).toBe(true);

    const code = readFileSync(codeFile, 'utf-8');
    expect(code).toBe('export function hello() { return "world"; }');
  });

  test('scrive manifest.json alla fine dell esecuzione', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor(), { outputDir });
    const instance = await runner.run({ task: 'test' });

    const manifestFile = join(outputDir, 'manifest.json');
    expect(existsSync(manifestFile)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    expect(manifest.instance_id).toBe(instance.instance_id);
    expect(manifest.workflow_id).toBe('simple_test');
    expect(manifest.state).toBe('completed');
    expect(manifest.phases).toHaveLength(1);
    expect(manifest.phases[0].id).toBe('write');
    expect(manifest.phases[0].outputs).toContain('code');
  });

  test('non scrive output se outputDir non e specificato', async () => {
    const ir = compileSource(SIMPLE_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    await runner.run({ task: 'test' });

    // Nessuna directory output creata
    expect(existsSync(outputDir)).toBe(false);
  });

  test('output incrementale funziona col loop', async () => {
    const ir = compileSource(LOOP_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor(), { outputDir });
    await runner.run({ task: 'test' });

    // Dopo il loop, i file devono esistere con l'ultimo output
    expect(existsSync(join(outputDir, 'write.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'review.json'))).toBe(true);

    const review = JSON.parse(readFileSync(join(outputDir, 'review.json'), 'utf-8'));
    expect(review.verdict).toBe('approved');
  });
});

// ─── Done-when + Confidence ────────────────────────────────────────

const DONE_WHEN_WORKFLOW = `workflow donewhen_test
  agents:
    agent writer
      model: "mock"
      mode: focused
      must_produce:
        - code

    agent critic
      model: "mock"
      mode: adversarial
      must_produce:
        - verdict
        - confidence: float

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [code]

    phase review
      agent: critic
      input: [write.code]
      output: [verdict, confidence]

  loop quality_gate
    phases: [write, review]
    repeat_while: review.verdict == "needs_work"
    max_iterations: 5
    on_each_iteration:
      send_to: writer
      payload: review.verdict

  done when: review.confidence >= 0.85 and review.verdict == "approved"
`;

describe('WorkflowRunner — done_when + confidence', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('workflow completed quando done_when e soddisfatto', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);

    // Executor che produce approved + confidence alta
    const executor = {
      execute: async (agent: { id: string; must_produce?: { name: string }[] }) => {
        if (agent.id === 'critic') {
          return { output: { verdict: 'approved', confidence: 0.95 } };
        }
        return { output: { code: 'const x = 1;' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    const instance = await runner.run({ task: 'test' });

    expect(instance.state).toBe('completed');
  });

  test('workflow failed quando confidence sotto soglia', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);

    // Critic approva ma con confidence bassa
    const executor = {
      execute: async (agent: { id: string; must_produce?: { name: string }[] }) => {
        if (agent.id === 'critic') {
          return { output: { verdict: 'approved', confidence: 0.6 } };
        }
        return { output: { code: 'const x = 1;' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    const instance = await runner.run({ task: 'test' });

    expect(instance.state).toBe('failed');
  });

  test('early exit dal loop quando done_when soddisfatto', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);

    let iterations = 0;
    const executor = {
      execute: async (agent: { id: string; must_produce?: { name: string }[] }) => {
        if (agent.id === 'critic') {
          iterations++;
          // Iterazione 1: needs_work. Iterazione 2: approved + alta confidence
          if (iterations >= 2) {
            return { output: { verdict: 'approved', confidence: 0.95 } };
          }
          return { output: { verdict: 'needs_work', confidence: 0.3 } };
        }
        return { output: { code: 'const x = 1;' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    const instance = await runner.run({ task: 'test' });

    expect(instance.state).toBe('completed');
    expect(instance.loop_iterations['quality_gate']).toBe(2);
  });

  test('done_when con MockAgentExecutor funziona end-to-end', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);
    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    const instance = await runner.run({ task: 'test' });

    // MockAgentExecutor: iter 1 → needs_work/0.5, iter 2 → approved/0.9
    expect(instance.state).toBe('completed');
    expect(instance.phase_outputs['review']['confidence']).toBe(0.9);
    expect(instance.phase_outputs['review']['verdict']).toBe('approved');
  });

  test('confronto float >= funziona correttamente al limite', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);

    // Confidence esattamente 0.85 — deve passare (>=)
    const executor = {
      execute: async (agent: { id: string }) => {
        if (agent.id === 'critic') {
          return { output: { verdict: 'approved', confidence: 0.85 } };
        }
        return { output: { code: 'x' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    const instance = await runner.run({ task: 'test' });

    expect(instance.state).toBe('completed');
  });
});

// ─── Convergenza del Critic (ExecutionContext) ─────────────────────

describe('WorkflowRunner — convergenza critic (ExecutionContext)', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('executor riceve ExecutionContext con loop info dentro il loop', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);

    const receivedContexts: unknown[] = [];
    const executor = {
      execute: async (
        agent: { id: string; must_produce?: { name: string }[] },
        _input: Record<string, unknown>,
        context?: unknown,
      ) => {
        receivedContexts.push({ agent: agent.id, context });
        if (agent.id === 'critic') {
          return { output: { verdict: 'approved', confidence: 0.95 } };
        }
        return { output: { code: 'x' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    await runner.run({ task: 'test' });

    // Entrambe le fasi nel loop devono ricevere il context
    const writerCtx = receivedContexts.find((c: any) => c.agent === 'writer') as any;
    const criticCtx = receivedContexts.find((c: any) => c.agent === 'critic') as any;

    expect(writerCtx.context).toBeDefined();
    expect(writerCtx.context.loop).toBeDefined();
    expect(writerCtx.context.loop.iteration).toBe(1);

    expect(criticCtx.context).toBeDefined();
    expect(criticCtx.context.loop.iteration).toBe(1);
    expect(criticCtx.context.loop.max_iterations).toBe(5);
  });

  test('acceptance_criteria contiene la condizione done_when come testo', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);

    let capturedCriteria: string | undefined;
    const executor = {
      execute: async (
        agent: { id: string; must_produce?: { name: string }[] },
        _input: Record<string, unknown>,
        context?: any,
      ) => {
        if (agent.id === 'critic' && context?.loop?.acceptance_criteria) {
          capturedCriteria = context.loop.acceptance_criteria;
        }
        if (agent.id === 'critic') {
          return { output: { verdict: 'approved', confidence: 0.95 } };
        }
        return { output: { code: 'x' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    await runner.run({ task: 'test' });

    expect(capturedCriteria).toBeDefined();
    expect(capturedCriteria).toContain('review.confidence');
    expect(capturedCriteria).toContain('>= 0.85');
    expect(capturedCriteria).toContain('review.verdict');
    expect(capturedCriteria).toContain('approved');
  });

  test('iteration nel context si aggiorna ad ogni iterazione del loop', async () => {
    const ir = compileSource(DONE_WHEN_WORKFLOW);

    const iterationsSeen: number[] = [];
    let callCount = 0;
    const executor = {
      execute: async (
        agent: { id: string; must_produce?: { name: string }[] },
        _input: Record<string, unknown>,
        context?: any,
      ) => {
        if (agent.id === 'critic') {
          callCount++;
          if (context?.loop) iterationsSeen.push(context.loop.iteration);
          if (callCount >= 2) {
            return { output: { verdict: 'approved', confidence: 0.95 } };
          }
          return { output: { verdict: 'needs_work', confidence: 0.4 } };
        }
        return { output: { code: 'x' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    await runner.run({ task: 'test' });

    expect(iterationsSeen).toEqual([1, 2]);
  });

  test('fasi fuori dal loop non ricevono loop context', async () => {
    // Workflow con fase pre-loop
    const source = `workflow ctx_test
  agents:
    agent planner
      model: "mock"
      mode: focused
      must_produce:
        - plan

    agent writer
      model: "mock"
      mode: focused
      must_produce:
        - code

    agent critic
      model: "mock"
      mode: adversarial
      must_produce:
        - verdict
        - confidence: float

  phases:
    phase planning
      agent: planner
      input: [trigger.task]
      output: [plan]

    phase write
      agent: writer
      input: [planning.plan]
      output: [code]

    phase review
      agent: critic
      input: [write.code]
      output: [verdict, confidence]

  loop quality_gate
    phases: [write, review]
    repeat_while: review.verdict == "needs_work"
    max_iterations: 3
`;

    const ir = compileSource(source);

    const contexts: { agent: string; hasLoop: boolean }[] = [];
    const executor = {
      execute: async (
        agent: { id: string; must_produce?: { name: string }[] },
        _input: Record<string, unknown>,
        context?: any,
      ) => {
        contexts.push({ agent: agent.id, hasLoop: !!context?.loop });
        if (agent.id === 'critic') return { output: { verdict: 'approved', confidence: 0.95 } };
        if (agent.id === 'planner') return { output: { plan: 'do stuff' } };
        return { output: { code: 'x' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    await runner.run({ task: 'test' });

    const plannerCtx = contexts.find((c) => c.agent === 'planner');
    const writerCtx = contexts.find((c) => c.agent === 'writer');

    expect(plannerCtx!.hasLoop).toBe(false); // pre-loop: no context
    expect(writerCtx!.hasLoop).toBe(true); // in-loop: has context
  });
});

// ─── inject_context / rules_file ──────────────────────────────────

const INJECT_CONTEXT_WORKFLOW = `workflow inject_test
  context:
    rules_file: "coding-standards.md"

  agents:
    agent writer
      model: "mock"
      mode: focused
      must_produce:
        - code
      inject_context: rules_file

    agent critic
      model: "mock"
      mode: adversarial
      must_produce:
        - verdict
        - confidence: float

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [code]

    phase review
      agent: critic
      input: [write.code]
      output: [verdict, confidence]

  loop quality_gate
    phases: [write, review]
    repeat_while: review.verdict == "needs_work"
    max_iterations: 3
`;

describe('WorkflowRunner — inject_context / rules_file', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tempDir = makeTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanup(tempDir);
  });

  test('injectedContext contiene il contenuto del file quando esiste', async () => {
    const rulesContent = '# Coding Standards\n- Use TypeScript\n- Write tests\n- No any types';
    writeFileSync(join(tempDir, 'coding-standards.md'), rulesContent);

    const ir = compileSource(INJECT_CONTEXT_WORKFLOW);

    let capturedContext: string | undefined;
    const executor = {
      execute: async (
        agent: { id: string; must_produce?: { name: string }[] },
        _input: Record<string, unknown>,
        context?: any,
      ) => {
        if (agent.id === 'writer' && context?.injectedContext) {
          capturedContext = context.injectedContext;
        }
        if (agent.id === 'critic') return { output: { verdict: 'approved', confidence: 0.9 } };
        return { output: { code: 'const x = 1;' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    await runner.run({ task: 'test' });

    expect(capturedContext).toBe(rulesContent);
  });

  test('agente senza inject_context non riceve injectedContext', async () => {
    writeFileSync(join(tempDir, 'coding-standards.md'), '# Rules');

    const ir = compileSource(INJECT_CONTEXT_WORKFLOW);

    let criticGotContext = false;
    const executor = {
      execute: async (
        agent: { id: string; must_produce?: { name: string }[] },
        _input: Record<string, unknown>,
        context?: any,
      ) => {
        if (agent.id === 'critic' && context?.injectedContext) {
          criticGotContext = true;
        }
        if (agent.id === 'critic') return { output: { verdict: 'approved', confidence: 0.9 } };
        return { output: { code: 'const x = 1;' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    await runner.run({ task: 'test' });

    expect(criticGotContext).toBe(false);
  });

  test('file mancante non blocca il workflow — warning + skip silenzioso', async () => {
    // Nessun file coding-standards.md nella directory
    const ir = compileSource(INJECT_CONTEXT_WORKFLOW);

    const runner = new WorkflowRunner(ir, new MockAgentExecutor());
    const instance = await runner.run({ task: 'test' });

    // Il workflow deve completare lo stesso
    expect(instance.state).toBe('completed');
  });

  test('chiave inject_context mancante nel workflow context — warning + skip', async () => {
    const source = `workflow inject_nokey_test
  agents:
    agent writer
      model: "mock"
      mode: focused
      must_produce:
        - code
      inject_context: nonexistent_key

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [code]
`;
    const ir = compileSource(source);

    let gotInjected = false;
    const executor = {
      execute: async (_agent: { id: string }, _input: Record<string, unknown>, context?: any) => {
        if (context?.injectedContext) gotInjected = true;
        return { output: { code: 'x' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    const instance = await runner.run({ task: 'test' });

    expect(instance.state).toBe('completed');
    expect(gotInjected).toBe(false);
  });

  test('injectedContext disponibile anche fuori dal loop', async () => {
    writeFileSync(join(tempDir, 'coding-standards.md'), '# Rules');

    const source = `workflow inject_noloop_test
  context:
    rules_file: "coding-standards.md"

  agents:
    agent writer
      model: "mock"
      mode: focused
      must_produce:
        - code
      inject_context: rules_file

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [code]
`;
    const ir = compileSource(source);

    let capturedContext: string | undefined;
    const executor = {
      execute: async (agent: { id: string }, _input: Record<string, unknown>, context?: any) => {
        capturedContext = context?.injectedContext;
        return { output: { code: 'x' } };
      },
    };

    const runner = new WorkflowRunner(ir, executor);
    await runner.run({ task: 'test' });

    expect(capturedContext).toBe('# Rules');
  });
});
