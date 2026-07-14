import { compile, compileSource, parseDuration } from '../src/compiler.js';
import { parse } from '../src/parser.js';
import { AGENTFLOW_VERSION } from '../src/version.js';

describe('Compiler', () => {
  test('compila workflow minimo → WorkflowIR con $schema, $agentflow_version, compiled_at', () => {
    const ir = compileSource('workflow minimal');
    expect(ir.$schema).toBe('https://agentflow.dev/ir/v0.1.schema.json');
    expect(ir.$agentflow_version).toBe(AGENTFLOW_VERSION);
    expect(ir.compiled_at).toBeDefined();
    expect(ir.workflow.id).toBe('minimal');
  });

  test('compila agente con must_produce → AgentDef con must_produce corretto', () => {
    const source = `workflow test
  agents:
    agent writer
      mode: focused
      must_produce:
        - code
        - tests`;
    const ir = compileSource(source);
    const agent = ir.workflow.agents['writer'];
    expect(agent).toBeDefined();
    expect(agent.mode).toBe('focused');
    expect(agent.must_produce).toBeDefined();
    expect(agent.must_produce!.length).toBe(2);
    expect(agent.must_produce![0].name).toBe('code');
    expect(agent.must_produce![1].name).toBe('tests');
  });

  test('compila "confidence: float" → must_produce["confidence"] === "float"', () => {
    const source = `workflow test
  agents:
    agent critic
      must_produce:
        - verdict
        - confidence: float`;
    const ir = compileSource(source);
    const agent = ir.workflow.agents['critic'];
    expect(agent.must_produce).toBeDefined();
    const confidenceItem = agent.must_produce!.find((m) => m.name === 'confidence');
    expect(confidenceItem).toBeDefined();
    expect(confidenceItem!.type).toBe('float');
  });

  test('compila fase con retry → PhaseDef con retry.max_attempts', () => {
    const source = `workflow test
  phases:
    phase provision
      agent: ssl_provisioner
      retry:
        max_attempts: 3
        backoff: 30s`;
    const ir = compileSource(source);
    const phase = ir.workflow.phases[0];
    expect(phase.retry).toBeDefined();
    expect(phase.retry!.max_attempts).toBe(3);
    expect(phase.retry!.backoff).toEqual({ value: 30, unit: 's' });
  });

  test('parseDuration("30s") → { value: 30, unit: "s" }', () => {
    expect(parseDuration('30s')).toEqual({ value: 30, unit: 's' });
  });

  test('parseDuration("5min") → { value: 5, unit: "min" }', () => {
    expect(parseDuration('5min')).toEqual({ value: 5, unit: 'min' });
  });

  test('parseDuration("48h") → { value: 48, unit: "h" }', () => {
    expect(parseDuration('48h')).toEqual({ value: 48, unit: 'h' });
  });

  test('parseDuration("7d") → { value: 7, unit: "d" }', () => {
    expect(parseDuration('7d')).toEqual({ value: 7, unit: 'd' });
  });

  test('parseDuration("formato_invalido") → throw Error', () => {
    expect(() => parseDuration('invalid')).toThrow();
    expect(() => parseDuration('30x')).toThrow();
    expect(() => parseDuration('')).toThrow();
  });

  test('compila done_when con condizione composta', () => {
    const source = `workflow test
  done when: review.confidence >= 0.85 and review.verdict == "approved"`;
    const ir = compileSource(source);
    expect(ir.workflow.done_when).toBeDefined();
    expect(ir.workflow.done_when!.kind).toBe('and');
  });

  test('compila agente con mode default "focused"', () => {
    const source = `workflow test
  agents:
    agent simple
      must_produce:
        - output`;
    const ir = compileSource(source);
    expect(ir.workflow.agents['simple'].mode).toBe('focused');
  });

  test('compila fase con type default "standard"', () => {
    const source = `workflow test
  phases:
    phase step1
      agent: worker`;
    const ir = compileSource(source);
    expect(ir.workflow.phases[0].type).toBe('standard');
  });

  test('compila agente con has_side_effects', () => {
    const source = `workflow test
  agents:
    agent writer_agent
      tools: [file_write, code_review]`;
    const ir = compileSource(source);
    expect(ir.workflow.agents['writer_agent'].has_side_effects).toBe(true);
  });

  test('compila loop', () => {
    const source = `workflow test
  loop quality_gate
    phases: [write, test, review]
    repeat_while: review.verdict == "needs_work"
    max_iterations: 5`;
    const ir = compileSource(source);
    expect(ir.workflow.loop).toBeDefined();
    expect(ir.workflow.loop!.id).toBe('quality_gate');
    expect(ir.workflow.loop!.phases).toEqual(['write', 'test', 'review']);
    expect(ir.workflow.loop!.max_iterations).toBe(5);
    expect(ir.workflow.loop!.repeat_while).toBeDefined();
  });
});
