import { parse } from './parser.js';
import type {
  ASTWorkflow,
  ASTAgent,
  ASTPhase,
  ASTLoop,
  ASTProperty,
  ASTValue,
  ASTBlock,
  ASTList,
  ASTCondition,
  ASTLiteral,
  ASTRef,
  WorkflowIR,
  AgentDef,
  PhaseDef,
  LoopDef,
  TriggerDef,
  Condition,
  ValueExpr,
  Duration,
  MustProduceItem,
  PollConfig,
  RetryConfig,
  RollbackOnFail,
  OnFailConfig,
  InstructionToUser,
  OnTimeoutConfig,
  RollbackConfig,
  OnSuccessConfig,
} from './types.js';
import { AGENTFLOW_VERSION } from './version.js';

const SIDE_EFFECT_TOOLS = new Set([
  'file_write',
  'database_write',
  'config_write',
  'traefik_api',
  'acme_client',
]);

// ─── Helpers ────────────────────────────────────────────────────────

function findProp(props: ASTProperty[], key: string): ASTProperty | undefined {
  return props.find((p) => p.key === key);
}

function getString(props: ASTProperty[], key: string): string | undefined {
  const prop = findProp(props, key);
  if (!prop) return undefined;
  if (prop.value.kind === 'literal') return String(prop.value.value);
  if (prop.value.kind === 'ref') return prop.value.path;
  return undefined;
}

function getNumber(props: ASTProperty[], key: string): number | undefined {
  const prop = findProp(props, key);
  if (!prop || prop.value.kind !== 'literal') return undefined;
  const val = prop.value.value;
  return typeof val === 'number' ? val : undefined;
}

function getBool(props: ASTProperty[], key: string): boolean | undefined {
  const prop = findProp(props, key);
  if (!prop || prop.value.kind !== 'literal') return undefined;
  return prop.value.value === true || prop.value.value === 'true';
}

function getStringList(props: ASTProperty[], key: string): string[] | undefined {
  const prop = findProp(props, key);
  if (!prop) return undefined;
  if (prop.value.kind === 'list') {
    return prop.value.items.map((item) => {
      if (item.kind === 'literal') return String(item.value);
      if (item.kind === 'ref') return item.path;
      return '';
    });
  }
  return undefined;
}

function getBlock(props: ASTProperty[], key: string): ASTProperty[] | undefined {
  const prop = findProp(props, key);
  if (!prop || prop.value.kind !== 'block') return undefined;
  return prop.value.properties;
}

// ─── Duration parser ─────────────────────────────────────────────────

export function parseDuration(s: string): Duration {
  const match = s.match(/^(\d+)(s|min|h|d)$/);
  if (!match) {
    throw new Error(
      `Invalid duration format: "${s}". Expected format: <number><unit> (e.g., 30s, 5min, 48h, 7d)`,
    );
  }
  return {
    value: parseInt(match[1], 10),
    unit: match[2] as Duration['unit'],
  };
}

function getDuration(props: ASTProperty[], key: string): Duration | undefined {
  const s = getString(props, key);
  if (!s) return undefined;
  return parseDuration(s);
}

// ─── Value compilation ──────────────────────────────────────────────

function compileValueExpr(ast: ASTValue): ValueExpr {
  if (ast.kind === 'ref') {
    return { kind: 'ref', path: ast.path };
  }
  if (ast.kind === 'literal') {
    if (ast.rawType === 'identifier') {
      // Could be a ref without dots
      return { kind: 'ref', path: String(ast.value) };
    }
    return { kind: 'literal', value: ast.value };
  }
  // Fallback
  return { kind: 'literal', value: '' };
}

// ─── Condition compilation ──────────────────────────────────────────

function compileCondition(ast: ASTValue): Condition {
  if (ast.kind === 'condition') {
    const cond = ast as ASTCondition;

    // Check if this is a compound condition (and/or)
    if (cond.logic === 'and' || cond.logic === 'or') {
      const left = compileCondition(cond.left);
      const right = compileCondition(cond.right);
      return {
        kind: cond.logic,
        conditions: [left, right],
      };
    }

    return {
      kind: 'compare',
      left: compileValueExpr(cond.left),
      op: cond.op as Condition extends { kind: 'compare' } ? Condition['op'] : never,
      right: compileValueExpr(cond.right),
    };
  }
  // Simple ref comparison fallback
  return {
    kind: 'compare',
    left: compileValueExpr(ast),
    op: '==',
    right: { kind: 'literal', value: true },
  };
}

// ─── Agent compilation ──────────────────────────────────────────────

function compileAgent(ast: ASTAgent): AgentDef {
  const props = ast.properties;

  const tools = getStringList(props, 'tools');
  const mustProduceList = compileMustProduce(props);
  const rules: string[] = props
    .filter((p) => p.key === 'rule')
    .map((p) => (p.value.kind === 'literal' ? String(p.value.value) : ''));
  const constraints: string[] = props
    .filter((p) => p.key === 'constraint')
    .map((p) => (p.value.kind === 'literal' ? String(p.value.value) : ''));

  const hasSideEffects = tools ? tools.some((t) => SIDE_EFFECT_TOOLS.has(t)) : undefined;

  const agent: AgentDef = {
    id: ast.id,
    model: getString(props, 'model'),
    mode: getString(props, 'mode') ?? 'focused',
    tools,
    must_produce: mustProduceList.length > 0 ? mustProduceList : undefined,
    output_schema: compileOutputSchema(props),
    validation: compileValidation(props),
    inject_context: getString(props, 'inject_context'),
    fail_fast: getBool(props, 'fail_fast'),
    constraints: constraints.length > 0 ? constraints : undefined,
    rules: rules.length > 0 ? rules : undefined,
    has_side_effects: hasSideEffects,
  };

  return agent;
}

function compileMustProduce(props: ASTProperty[]): MustProduceItem[] {
  const prop = findProp(props, 'must_produce');
  if (!prop) return [];

  if (prop.value.kind === 'list') {
    return prop.value.items.map((item) => {
      if (item.kind === 'literal') {
        return { name: String(item.value) };
      }
      if (item.kind === 'block') {
        const block = item as ASTBlock;
        if (block.properties.length > 0) {
          const p = block.properties[0];
          return {
            name: p.key,
            type: p.value.kind === 'literal' ? String(p.value.value) : undefined,
          };
        }
      }
      return { name: '' };
    });
  }

  // Block-based must_produce (dash list parsed as block)
  if (prop.value.kind === 'block') {
    return prop.value.properties.map((p) => ({
      name: p.key,
      type:
        p.value.kind === 'literal' && p.value.rawType !== 'identifier'
          ? String(p.value.value)
          : p.value.kind === 'literal' &&
              p.value.rawType === 'identifier' &&
              p.key !== String(p.value.value)
            ? String(p.value.value)
            : undefined,
    }));
  }

  return [];
}

function compileOutputSchema(props: ASTProperty[]): Record<string, unknown> | undefined {
  const prop = findProp(props, 'output_schema');
  if (!prop) return undefined;

  try {
    // Serialize AST to JSON: blocks become objects, lists become arrays, literals become values
    return astValueToPlain(prop.value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function compileValidation(
  props: ASTProperty[],
): { retry?: number; on_fail?: 'abort' | 'default' } | undefined {
  const prop = findProp(props, 'validation');
  if (!prop || prop.value.kind !== 'block') return undefined;

  const vProps = prop.value.properties;
  const retry = getNumber(vProps, 'retry');
  const onFail = getString(vProps, 'on_fail') as 'abort' | 'default' | undefined;

  if (retry === undefined && !onFail) return undefined;
  return { retry, on_fail: onFail || 'default' };
}

function astValueToPlain(value: ASTValue): unknown {
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'list') return value.items.map(astValueToPlain);
  if (value.kind === 'block') {
    const obj: Record<string, unknown> = {};
    for (const p of value.properties) {
      obj[p.key] = astValueToPlain(p.value);
    }
    return obj;
  }
  return null;
}

// ─── Phase compilation ──────────────────────────────────────────────

function compilePhase(ast: ASTPhase): PhaseDef {
  const props = ast.properties;

  const phase: PhaseDef = {
    id: ast.id,
    agent: getString(props, 'agent') ?? '',
    input: getStringList(props, 'input'),
    output: getStringList(props, 'output'),
    type: getString(props, 'type') ?? 'standard',
    timeout: getDuration(props, 'timeout'),
    irreversible: getBool(props, 'irreversible'),
  };

  // Poll config
  const pollBlock = getBlock(props, 'poll');
  if (pollBlock) {
    phase.poll = {
      interval: getDuration(pollBlock, 'interval'),
      backoff: getString(pollBlock, 'backoff'),
      max_wait: getDuration(pollBlock, 'max_wait'),
      condition: compilePropCondition(pollBlock, 'condition'),
    };
  }

  // Retry config
  const retryBlock = getBlock(props, 'retry');
  if (retryBlock) {
    const backoffStr = getString(retryBlock, 'backoff');
    phase.retry = {
      max_attempts: getNumber(retryBlock, 'max_attempts'),
      backoff: backoffStr ? (tryParseDuration(backoffStr) ?? backoffStr) : undefined,
      condition: compilePropCondition(retryBlock, 'condition'),
    };

    const onAllFailedBlock = getBlock(retryBlock, 'on_all_failed');
    if (onAllFailedBlock) {
      const rescheduleStr = getString(onAllFailedBlock, 'reschedule');
      phase.retry.on_all_failed = {
        escalate_to: getString(onAllFailedBlock, 'escalate_to'),
        reschedule: rescheduleStr ? parseDuration(rescheduleStr) : undefined,
      };
    }
  }

  // Rollback on fail
  const rollbackBlock = getBlock(props, 'rollback_on_fail');
  if (rollbackBlock) {
    phase.rollback_on_fail = {
      undo: getStringList(rollbackBlock, 'undo') ?? [],
    };
  }

  // On fail
  const onFailBlock = getBlock(props, 'on_fail');
  if (onFailBlock) {
    phase.on_fail = {
      condition: compilePropCondition(onFailBlock, 'condition'),
      action: getString(onFailBlock, 'action'),
      message: getString(onFailBlock, 'message'),
      then: getString(onFailBlock, 'then'),
    };
  }

  // Instruction to user
  const instructionBlock = getBlock(props, 'instruction_to_user');
  if (instructionBlock) {
    phase.instruction_to_user = {
      message: getString(instructionBlock, 'message') ?? '',
      data: getString(instructionBlock, 'data'),
      format: getString(instructionBlock, 'format'),
    };
  }

  // Completes when
  const completesWhen = getString(props, 'completes_when');
  if (completesWhen) {
    phase.completes_when = completesWhen;
  }

  // On timeout
  const onTimeoutBlock = getBlock(props, 'on_timeout');
  if (onTimeoutBlock) {
    phase.on_timeout = {
      action: getString(onTimeoutBlock, 'action'),
      then: getString(onTimeoutBlock, 'then'),
    };
  }

  return phase;
}

function compilePropCondition(props: ASTProperty[], key: string): Condition | undefined {
  const prop = findProp(props, key);
  if (!prop) return undefined;
  return compileCondition(prop.value);
}

function tryParseDuration(s: string): Duration | undefined {
  try {
    return parseDuration(s);
  } catch {
    return undefined;
  }
}

// ─── Loop compilation ───────────────────────────────────────────────

function compileLoop(ast: ASTLoop): LoopDef {
  const props = ast.properties;

  const loop: LoopDef = {
    id: ast.id,
    phases: getStringList(props, 'phases') ?? [],
    max_iterations: getNumber(props, 'max_iterations'),
  };

  // repeat_while
  const repeatWhile = findProp(props, 'repeat_while');
  if (repeatWhile) {
    loop.repeat_while = compileCondition(repeatWhile.value);
  }

  // on_each_iteration
  const onEachBlock = getBlock(props, 'on_each_iteration');
  if (onEachBlock) {
    loop.on_each_iteration = {
      send_to: getString(onEachBlock, 'send_to'),
      payload: getString(onEachBlock, 'payload'),
    };
  }

  // on_max_exceeded
  const onMaxBlock = getBlock(props, 'on_max_exceeded');
  if (onMaxBlock) {
    loop.on_max_exceeded = {
      escalate_to: getString(onMaxBlock, 'escalate_to'),
      message: getString(onMaxBlock, 'message'),
      attach: getStringList(onMaxBlock, 'attach'),
    };
  }

  return loop;
}

// ─── Trigger compilation ────────────────────────────────────────────

function compileTrigger(props: ASTProperty[]): TriggerDef | undefined {
  const triggerBlock = getBlock(props, 'trigger');
  if (!triggerBlock) return undefined;

  const inputProp = findProp(triggerBlock, 'input');
  let inputs: Array<{ name: string; type: string }> | undefined;

  if (inputProp) {
    if (inputProp.value.kind === 'list') {
      inputs = inputProp.value.items.map((item) => {
        if (item.kind === 'block') {
          const p = item.properties[0];
          return {
            name: p.key,
            type: p.value.kind === 'literal' ? String(p.value.value) : 'string',
          };
        }
        if (item.kind === 'literal') {
          return { name: String(item.value), type: 'string' };
        }
        return { name: '', type: 'string' };
      });
    }
  }

  return {
    on_event: getString(triggerBlock, 'on_event'),
    input: inputs,
  };
}

// ─── Context compilation ────────────────────────────────────────────

function compileContext(props: ASTProperty[]): Record<string, ValueExpr | string> | undefined {
  const contextBlock = getBlock(props, 'context');
  if (!contextBlock) return undefined;

  const ctx: Record<string, ValueExpr | string> = {};
  for (const prop of contextBlock) {
    if (prop.value.kind === 'literal') {
      ctx[prop.key] = String(prop.value.value);
    } else if (prop.value.kind === 'ref') {
      ctx[prop.key] = { kind: 'ref', path: prop.value.path };
    }
  }
  return ctx;
}

// ─── Rollback compilation ───────────────────────────────────────────

function compileRollback(props: ASTProperty[]): RollbackConfig | undefined {
  const block = getBlock(props, 'rollback');
  if (!block) return undefined;

  return {
    priority_order: getStringList(block, 'priority_order'),
    notify_user: getBool(block, 'notify_user'),
    log_to: getString(block, 'log_to'),
  };
}

// ─── On success compilation ─────────────────────────────────────────

function compileOnSuccess(props: ASTProperty[]): OnSuccessConfig | undefined {
  const block = getBlock(props, 'on_success');
  if (!block) return undefined;

  const notifyBlock = getBlock(block, 'notify_user');
  if (!notifyBlock) return undefined;

  return {
    notify_user: {
      message: getString(notifyBlock, 'message') ?? '',
      attach: getStringList(notifyBlock, 'attach'),
    },
  };
}

// ─── Main compiler ──────────────────────────────────────────────────

export function compile(ast: ASTWorkflow): WorkflowIR {
  const agents: Record<string, AgentDef> = {};
  for (const agentAst of ast.agents) {
    const compiled = compileAgent(agentAst);
    agents[compiled.id] = compiled;
  }

  const phases: PhaseDef[] = ast.phases.map(compilePhase);
  const loop = ast.loop ? compileLoop(ast.loop) : undefined;

  // Compile done_when
  const doneWhenProp = findProp(ast.properties, 'done_when');
  const doneWhen = doneWhenProp ? compileCondition(doneWhenProp.value) : undefined;

  return {
    $schema: 'https://agentflow.dev/ir/v0.1.schema.json',
    $agentflow_version: AGENTFLOW_VERSION,
    compiled_at: new Date().toISOString(),
    workflow: {
      id: ast.id,
      description: getString(ast.properties, 'description'),
      version: getString(ast.properties, 'version'),
      trigger: compileTrigger(ast.properties),
      context: compileContext(ast.properties),
      agents,
      phases,
      loop,
      done_when: doneWhen,
      rollback: compileRollback(ast.properties),
      on_success: compileOnSuccess(ast.properties),
      max_cost: getNumber(ast.properties, 'max_cost'),
    },
  };
}

export function compileSource(source: string): WorkflowIR {
  const ast = parse(source);
  return compile(ast);
}
