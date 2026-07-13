import type { WorkflowIR, ValidationResult, ValidationIssue, Condition } from './types.js';
import { resolveModel } from './model-resolver.js';
import { BUILTIN_TOOL_NAMES } from './tools/index.js';

/** Providers whose executors actually run agent `tools`. Others ignore them. */
const TOOL_EXECUTING_PROVIDERS: ReadonlySet<string> = new Set(['claude']);

/** Collect all `phase.field` reference paths inside a condition tree. */
function collectConditionRefs(cond: Condition | undefined, out: string[]): void {
  if (!cond) return;
  switch (cond.kind) {
    case 'compare':
      for (const side of [cond.left, cond.right]) {
        if (side && typeof side === 'object' && 'kind' in side && side.kind === 'ref') {
          out.push((side as { path: string }).path);
        }
      }
      break;
    case 'and':
    case 'or':
      for (const c of cond.conditions) collectConditionRefs(c, out);
      break;
    case 'not':
      collectConditionRefs(cond.condition, out);
      break;
  }
}

export function validate(ir: WorkflowIR): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const { agents, phases, loop } = ir.workflow;

  // S1: phase.agent must exist in agents
  for (const phase of phases) {
    if (phase.agent && !agents[phase.agent]) {
      errors.push({
        rule: 'S1',
        message: `Phase "${phase.id}" references undefined agent "${phase.agent}".`,
        phase: phase.id,
      });
    }
  }

  // S2: every output declared in phase.output must be in agent's must_produce
  for (const phase of phases) {
    if (phase.output && phase.agent && agents[phase.agent]) {
      const agent = agents[phase.agent];
      const produces = new Set(agent.must_produce?.map((m) => m.name) ?? []);
      for (const out of phase.output) {
        if (!produces.has(out)) {
          errors.push({
            rule: 'S2',
            message: `Output "${out}" of phase "${phase.id}" is not in must_produce of agent "${phase.agent}".`,
            phase: phase.id,
            agent: phase.agent,
          });
        }
      }
    }
  }

  // S3: every phase referenced in loop.phases must exist in phases
  if (loop) {
    const phaseIds = new Set(phases.map((p) => p.id));
    for (const loopPhaseId of loop.phases) {
      if (!phaseIds.has(loopPhaseId)) {
        errors.push({
          rule: 'S3',
          message: `Loop "${loop.id}" references phase "${loopPhaseId}" which does not exist.`,
        });
      }
    }
  }

  // S4: agent without must_produce — warning
  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent.must_produce || agent.must_produce.length === 0) {
      warnings.push({
        rule: 'S4',
        message: `Agent "${agentId}" has no must_produce — outputs will not be validated at runtime.`,
        agent: agentId,
      });
    }
  }

  // S5: loop without max_iterations (or max_iterations <= 0)
  if (loop) {
    if (!loop.max_iterations || loop.max_iterations <= 0) {
      errors.push({
        rule: 'S5',
        message: `Loop "${loop.id}" has no max_iterations or has a value <= 0.`,
      });
    }
  }

  // S6: must_produce['confidence'] must be of type float
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.must_produce) {
      const confidenceItem = agent.must_produce.find((m) => m.name === 'confidence');
      if (confidenceItem && confidenceItem.type && confidenceItem.type !== 'float') {
        errors.push({
          rule: 'S6',
          message: `Agent "${agentId}" has must_produce "confidence" with type "${confidenceItem.type}" but it must be "float".`,
          agent: agentId,
        });
      }
    }
  }

  // S7: adversarial agent with constraint containing 'agree' or 'approve'
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.mode === 'adversarial' && agent.constraints) {
      for (const constraint of agent.constraints) {
        const lower = constraint.toLowerCase();
        if (lower.includes('agree') || lower.includes('approve')) {
          warnings.push({
            rule: 'S7',
            message: `Adversarial agent "${agentId}" has a constraint with 'agree' or 'approve' — may conflict with its role.`,
            agent: agentId,
          });
        }
      }
    }
  }

  // S8: like S7 but for phases — check constraints of the agent used by the phase
  for (const phase of phases) {
    if (phase.agent && agents[phase.agent]) {
      const agent = agents[phase.agent];
      if (agent.mode === 'adversarial' && agent.constraints) {
        for (const constraint of agent.constraints) {
          const lower = constraint.toLowerCase();
          if (lower.includes('agree') || lower.includes('approve')) {
            warnings.push({
              rule: 'S8',
              message: `Phase "${phase.id}" uses adversarial agent "${phase.agent}" with a suspicious constraint.`,
              phase: phase.id,
            });
          }
        }
      }
    }
  }

  // S9: human_action_required phase without timeout
  for (const phase of phases) {
    if (phase.type === 'human_action_required' && !phase.timeout) {
      errors.push({
        rule: 'S9',
        message: `Phase "${phase.id}" is of type "human_action_required" but has no timeout.`,
        phase: phase.id,
      });
    }
  }

  // S10: phase with both poll and retry
  for (const phase of phases) {
    if (phase.poll && phase.retry) {
      errors.push({
        rule: 'S10',
        message: `Phase "${phase.id}" has both poll and retry — this is not allowed.`,
        phase: phase.id,
      });
    }
  }

  // S11: dangling references — every `x.field` ref must point to a defined phase,
  // a defined agent (runtime resolves agent-named outputs), or "trigger"
  {
    const phaseIds = new Set(phases.map((p) => p.id));
    const agentIds = new Set(Object.keys(agents));
    const validPrefix = (ref: string): boolean => {
      const prefix = ref.split('.')[0];
      return prefix === 'trigger' || phaseIds.has(prefix) || agentIds.has(prefix);
    };

    // phase.input refs
    for (const phase of phases) {
      for (const ref of phase.input ?? []) {
        if (ref.includes('.') && !validPrefix(ref)) {
          errors.push({
            rule: 'S11',
            message: `Phase "${phase.id}" input references "${ref}" but "${ref.split('.')[0]}" is not a defined phase, agent, or "trigger".`,
            phase: phase.id,
          });
        }
      }
    }

    // done_when refs
    const doneRefs: string[] = [];
    collectConditionRefs(ir.workflow.done_when, doneRefs);
    for (const ref of doneRefs) {
      if (!validPrefix(ref)) {
        errors.push({
          rule: 'S11',
          message: `done_when references "${ref}" but "${ref.split('.')[0]}" is not a defined phase, agent, or "trigger" — the condition would never be satisfied.`,
        });
      }
    }

    // loop refs: repeat_while, on_each_iteration payload/send_to, on_max_exceeded escalate_to
    if (loop) {
      const loopRefs: string[] = [];
      collectConditionRefs(loop.repeat_while, loopRefs);
      for (const ref of loopRefs) {
        if (!validPrefix(ref)) {
          errors.push({
            rule: 'S11',
            message: `Loop "${loop.id}" repeat_while references "${ref}" but "${ref.split('.')[0]}" is not a defined phase, agent, or "trigger".`,
          });
        }
      }
      // payload: only validate strings shaped like a reference ("phase.field");
      // anything else is treated as a literal feedback message by the runtime
      const payload = loop.on_each_iteration?.payload;
      if (payload && /^[A-Za-z_]\w*\.[A-Za-z_][\w.]*$/.test(payload) && !validPrefix(payload)) {
        errors.push({
          rule: 'S11',
          message: `Loop "${loop.id}" on_each_iteration payload references "${payload}" but "${payload.split('.')[0]}" is not a defined phase, agent, or "trigger".`,
        });
      }
      const sendTo = loop.on_each_iteration?.send_to;
      if (sendTo && !agents[sendTo]) {
        errors.push({
          rule: 'S11',
          message: `Loop "${loop.id}" on_each_iteration send_to references undefined agent "${sendTo}".`,
        });
      }
      // escalate_to may name a human/external target — escalation is log-only today, so warn
      const escalateTo = loop.on_max_exceeded?.escalate_to;
      if (escalateTo && !agents[escalateTo]) {
        warnings.push({
          rule: 'S11',
          message: `Loop "${loop.id}" on_max_exceeded escalate_to "${escalateTo}" is not a defined agent — escalation is currently log-only, so this is allowed but unenforced.`,
        });
      }
    }
  }

  // S12: features that parse but are not executed by the current runtime — warn loudly
  {
    // human_action_required and rollback_on_fail ARE executed by the runtime now.
    const EXECUTED_TYPES = new Set(['standard', 'human_action_required']);
    const IGNORED_PHASE_FEATURES: Array<[string, (p: (typeof phases)[number]) => boolean]> = [
      ['streaming_batch', (p) => p.type === 'streaming_batch'],
      [
        'type (non-standard)',
        (p) => p.type !== undefined && !EXECUTED_TYPES.has(p.type) && p.type !== 'streaming_batch',
      ],
      ['poll', (p) => p.poll !== undefined],
      ['retry', (p) => p.retry !== undefined],
      ['timeout', (p) => p.timeout !== undefined],
      ['completes_when', (p) => p.completes_when !== undefined],
      ['on_timeout', (p) => p.on_timeout !== undefined],
    ];

    for (const phase of phases) {
      const ignored = IGNORED_PHASE_FEATURES.filter(([, test]) => test(phase)).map(
        ([name]) => name,
      );
      if (ignored.length > 0) {
        warnings.push({
          rule: 'S12',
          message: `Phase "${phase.id}" uses ${ignored.join(', ')} — parsed but NOT executed by the current runtime (see ROADMAP).`,
          phase: phase.id,
        });
      }
    }

    if (ir.workflow.rollback) {
      warnings.push({
        rule: 'S12',
        message: `Workflow declares a rollback config — parsed but NOT executed by the current runtime (see ROADMAP).`,
      });
    }
  }

  // S13: irreversible phase inside a loop — approval covers every iteration, so re-execution is a risk
  if (loop) {
    const loopPhaseIds = new Set(loop.phases);
    for (const phase of phases) {
      if (phase.irreversible && loopPhaseIds.has(phase.id)) {
        warnings.push({
          rule: 'S13',
          message: `Irreversible phase "${phase.id}" is inside loop "${loop.id}" — a single approval allows it to execute on EVERY iteration (up to ${loop.max_iterations ?? '∞'} times).`,
          phase: phase.id,
        });
      }
    }
  }

  // S14: tools are only executed by the `claude` provider. Every other provider
  // ignores agent.tools silently and the model hallucinates their results. Also
  // reject tool names that no built-in tool implements — those are dropped at
  // runtime today (e.g. `code_review`), so the model invents their output too.
  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent.tools || agent.tools.length === 0) continue;

    // Unknown tool names → error listing the known tools.
    const unknown = agent.tools.filter(
      (t) => !(BUILTIN_TOOL_NAMES as readonly string[]).includes(t),
    );
    if (unknown.length > 0) {
      errors.push({
        rule: 'S14',
        agent: agentId,
        message: `Agent "${agentId}" declares unknown tool(s): ${unknown.join(', ')}. Known tools: ${BUILTIN_TOOL_NAMES.join(', ')}. Unknown tools are silently dropped at runtime — remove them or use a known tool.`,
      });
    }

    // Tools on a provider that does not execute them → error.
    const modelConfig = resolveModel(agent.model);
    if (!TOOL_EXECUTING_PROVIDERS.has(modelConfig.provider)) {
      errors.push({
        rule: 'S14',
        agent: agentId,
        message: `Agent "${agentId}" declares tools [${agent.tools.join(', ')}] but its model "${agent.model ?? 'auto'}" resolves to provider "${modelConfig.provider}", which does not execute tools (only "claude" does) — the model would hallucinate the tool results. Either switch the agent to a claude model, or remove its tools.`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
