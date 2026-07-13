import { validate } from '../src/validate.js';
import type { WorkflowIR, AgentDef, PhaseDef, LoopDef } from '../src/types.js';

function makeIR(overrides: Partial<WorkflowIR['workflow']> = {}): WorkflowIR {
  return {
    $schema: 'https://agentflow.dev/ir/v0.1.schema.json',
    $agentflow_version: '0.1.0',
    compiled_at: new Date().toISOString(),
    workflow: {
      id: 'test',
      agents: {},
      phases: [],
      ...overrides,
    },
  };
}

function makeAgent(id: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return { id, mode: 'focused', ...overrides };
}

function makePhase(id: string, overrides: Partial<PhaseDef> = {}): PhaseDef {
  return { id, agent: 'default_agent', type: 'standard', ...overrides };
}

describe('Validator', () => {
  test('S1: fase con agente inesistente → errors include S1', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer') },
      phases: [makePhase('validate', { agent: 'nonexistent' })],
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === 'S1')).toBe(true);
  });

  test('S2: fase con output non in must_produce → errors include S2', () => {
    const ir = makeIR({
      agents: {
        writer: makeAgent('writer', {
          must_produce: [{ name: 'code' }],
        }),
      },
      phases: [makePhase('write', { agent: 'writer', output: ['code', 'missing_field'] })],
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === 'S2')).toBe(true);
    expect(result.errors.find((e) => e.rule === 'S2')!.message).toContain('missing_field');
  });

  test('S3: loop con fase inesistente → errors include S3', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer') },
      phases: [makePhase('write', { agent: 'writer' })],
      loop: {
        id: 'quality_gate',
        phases: ['write', 'nonexistent_phase'],
        max_iterations: 5,
      },
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === 'S3')).toBe(true);
  });

  test('S5: loop senza max_iterations → errors include S5', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer') },
      phases: [makePhase('write', { agent: 'writer' })],
      loop: {
        id: 'infinite_loop',
        phases: ['write'],
      } as LoopDef,
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === 'S5')).toBe(true);
  });

  test('S9: human_action_required senza timeout → errors include S9', () => {
    const ir = makeIR({
      agents: { user: makeAgent('user') },
      phases: [makePhase('await_user', { agent: 'user', type: 'human_action_required' })],
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === 'S9')).toBe(true);
  });

  test('S10: fase con poll e retry → errors include S10', () => {
    const ir = makeIR({
      agents: { checker: makeAgent('checker') },
      phases: [
        makePhase('check', {
          agent: 'checker',
          poll: { interval: { value: 5, unit: 'min' } },
          retry: { max_attempts: 3 },
        }),
      ],
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === 'S10')).toBe(true);
  });

  test('workflow valido → ok: true, errors: []', () => {
    const ir = makeIR({
      agents: {
        writer: makeAgent('writer', {
          must_produce: [{ name: 'code' }, { name: 'tests' }],
        }),
      },
      phases: [makePhase('write', { agent: 'writer', output: ['code', 'tests'] })],
    });
    const result = validate(ir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('S4: agente senza must_produce → warning', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer') },
      phases: [makePhase('write', { agent: 'writer' })],
    });
    const result = validate(ir);
    expect(result.warnings.some((w) => w.rule === 'S4')).toBe(true);
  });

  test('S6: must_produce confidence non float → error S6', () => {
    const ir = makeIR({
      agents: {
        critic: makeAgent('critic', {
          must_produce: [{ name: 'confidence', type: 'string' }],
        }),
      },
      phases: [],
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S6')).toBe(true);
  });

  test('S6: must_produce confidence float → no error', () => {
    const ir = makeIR({
      agents: {
        critic: makeAgent('critic', {
          must_produce: [{ name: 'confidence', type: 'float' }],
        }),
      },
      phases: [],
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S6')).toBe(false);
  });

  test('S7: agente adversarial con constraint approve → warning', () => {
    const ir = makeIR({
      agents: {
        critic: makeAgent('critic', {
          mode: 'adversarial',
          constraints: ['must approve all code'],
        }),
      },
      phases: [],
    });
    const result = validate(ir);
    expect(result.warnings.some((w) => w.rule === 'S7')).toBe(true);
  });

  // ─── S11: dangling references ───────────────────────────────────

  test('S11: input che referenzia fase inesistente → error', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [
        makePhase('write', { agent: 'writer', input: ['ghost_phase.field'], output: ['draft'] }),
      ],
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S11')).toBe(true);
  });

  test('S11: input trigger.* e fase precedente → ok', () => {
    const ir = makeIR({
      agents: {
        researcher: makeAgent('researcher', { must_produce: [{ name: 'outline' }] }),
        writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }),
      },
      phases: [
        makePhase('research', {
          agent: 'researcher',
          input: ['trigger.topic'],
          output: ['outline'],
        }),
        makePhase('write', { agent: 'writer', input: ['research.outline'], output: ['draft'] }),
      ],
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S11')).toBe(false);
  });

  test('S11: done_when che referenzia fase inesistente → error', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [makePhase('write', { agent: 'writer', output: ['draft'] })],
      done_when: {
        kind: 'compare',
        left: { kind: 'ref', path: 'ghost_phase.confidence' },
        op: '>=',
        right: { kind: 'literal', value: 0.8 },
      },
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S11')).toBe(true);
  });

  test('S11: done_when annidato (and/or) con ref valido → ok', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [makePhase('write', { agent: 'writer', output: ['draft'] })],
      done_when: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare',
            left: { kind: 'ref', path: 'write.confidence' },
            op: '>=',
            right: { kind: 'literal', value: 0.8 },
          },
        ],
      },
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S11')).toBe(false);
  });

  test('S11: loop repeat_while e send_to con riferimenti rotti → errors', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [makePhase('write', { agent: 'writer', output: ['draft'] })],
      loop: {
        id: 'cycle',
        phases: ['write'],
        max_iterations: 3,
        repeat_while: {
          kind: 'compare',
          left: { kind: 'ref', path: 'ghost.verdict' },
          op: '==',
          right: { kind: 'literal', value: 'needs_work' },
        },
        on_each_iteration: { send_to: 'ghost_agent', payload: 'ghost.suggestions' },
      } as LoopDef,
    });
    const result = validate(ir);
    const s11 = result.errors.filter((e) => e.rule === 'S11');
    expect(s11.length).toBe(3); // repeat_while + payload + send_to
  });

  test('S11: ref per agent-id (runtime li risolve) → nessun errore', () => {
    const ir = makeIR({
      agents: {
        health_checker: makeAgent('health_checker', { must_produce: [{ name: 'ssl_valid' }] }),
      },
      phases: [makePhase('verify', { agent: 'health_checker', output: ['ssl_valid'] })],
      done_when: {
        kind: 'compare',
        left: { kind: 'ref', path: 'health_checker.ssl_valid' },
        op: '==',
        right: { kind: 'literal', value: true },
      },
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S11')).toBe(false);
  });

  test('S11: payload letterale (frase) → nessun errore', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [makePhase('write', { agent: 'writer', output: ['draft'] })],
      loop: {
        id: 'cycle',
        phases: ['write'],
        max_iterations: 3,
        on_each_iteration: { send_to: 'writer', payload: 'Too short. Expand to 50 words.' },
      } as LoopDef,
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S11')).toBe(false);
  });

  test('S11: escalate_to non definito → warning, non errore (escalation log-only)', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [makePhase('write', { agent: 'writer', output: ['draft'] })],
      loop: {
        id: 'cycle',
        phases: ['write'],
        max_iterations: 3,
        on_max_exceeded: { escalate_to: 'human_reviewer', message: 'help' },
      } as LoopDef,
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S11')).toBe(false);
    expect(result.warnings.some((w) => w.rule === 'S11')).toBe(true);
  });

  // ─── S12: parsed-but-ignored features ───────────────────────────

  test('S12: fase human_action_required con timeout → warning (non eseguita a runtime)', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [
        makePhase('approve', {
          agent: 'writer',
          type: 'human_action_required',
          timeout: { value: 30, unit: 'min' } as PhaseDef['timeout'],
          output: ['draft'],
        }),
      ],
    });
    const result = validate(ir);
    const s12 = result.warnings.filter((w) => w.rule === 'S12');
    expect(s12.length).toBe(1);
    expect(s12[0].message).toContain('NOT executed');
  });

  test('S12: fase standard senza feature ignorate → nessun warning', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [makePhase('write', { agent: 'writer', output: ['draft'] })],
    });
    const result = validate(ir);
    expect(result.warnings.some((w) => w.rule === 'S12')).toBe(false);
  });

  test('S12: streaming_batch phase → named warning', () => {
    const ir = makeIR({
      agents: { writer: makeAgent('writer', { must_produce: [{ name: 'draft' }] }) },
      phases: [makePhase('batch', { agent: 'writer', type: 'streaming_batch', output: ['draft'] })],
    });
    const result = validate(ir);
    const s12 = result.warnings.filter((w) => w.rule === 'S12');
    expect(s12.length).toBe(1);
    expect(s12[0].message).toContain('streaming_batch');
  });

  // ─── S14: tools guard (provider + unknown tools) ────────────────

  test('S14: tools on a non-claude provider → error', () => {
    const ir = makeIR({
      agents: {
        writer: makeAgent('writer', {
          model: 'openrouter-smart',
          tools: ['file_write'],
          must_produce: [{ name: 'draft' }],
        }),
      },
      phases: [],
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    const s14 = result.errors.filter((e) => e.rule === 'S14');
    expect(s14.length).toBe(1);
    expect(s14[0].message).toMatch(/openrouter/);
    expect(s14[0].message).toMatch(/does not execute tools/);
  });

  test('S14: unknown tool name → error listing known tools', () => {
    const ir = makeIR({
      agents: {
        writer: makeAgent('writer', {
          model: 'claude-sonnet',
          tools: ['file_write', 'code_review'],
          must_produce: [{ name: 'draft' }],
        }),
      },
      phases: [],
    });
    const result = validate(ir);
    expect(result.ok).toBe(false);
    const s14 = result.errors.filter((e) => e.rule === 'S14');
    expect(s14.length).toBe(1);
    expect(s14[0].message).toContain('code_review');
    expect(s14[0].message).toContain('file_write, file_read, shell_exec, test_runner');
  });

  test('S14: known tools on a claude model → no error', () => {
    const ir = makeIR({
      agents: {
        writer: makeAgent('writer', {
          model: 'claude-sonnet',
          tools: ['file_write', 'test_runner'],
          must_produce: [{ name: 'draft' }],
        }),
      },
      phases: [],
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S14')).toBe(false);
  });

  test('S14: agent without tools → no error', () => {
    const ir = makeIR({
      agents: {
        writer: makeAgent('writer', {
          model: 'openrouter-smart',
          must_produce: [{ name: 'draft' }],
        }),
      },
      phases: [],
    });
    const result = validate(ir);
    expect(result.errors.some((e) => e.rule === 'S14')).toBe(false);
  });
});
