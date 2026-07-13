import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateJsonSchema } from './schema-validator.js';
import type {
  WorkflowIR,
  AgentDef,
  PhaseDef,
  Condition,
  ValueExpr,
  WorkflowInstance,
  PhaseState,
  WorkflowState,
  ExecutionMetrics,
  ExecutionReceipt,
  ExecutionStep,
} from './types.js';
import { logger } from './logger.js';

// ─── State Validation ──────────────────────────────────────────────

/** RFC-4122-ish UUID matcher (any version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
]);

/** Minimal structural validation for a persisted WorkflowInstance loaded from disk. */
function isValidInstanceShape(v: unknown): v is WorkflowInstance {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const isObj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (typeof o.instance_id !== 'string' || !UUID_RE.test(o.instance_id)) return false;
  if (typeof o.workflow_id !== 'string') return false;
  if (typeof o.state !== 'string' || !VALID_STATES.has(o.state)) return false;
  if (!isObj(o.trigger_input)) return false;
  if (!isObj(o.phase_states)) return false;
  if (!isObj(o.phase_outputs)) return false;
  if (!isObj(o.loop_iterations)) return false;
  return true;
}

// ─── Execution Context ─────────────────────────────────────────────

export type ExecutionContext = {
  loop?: {
    iteration: number;
    max_iterations?: number;
    acceptance_criteria?: string;
  };
  injectedContext?: string;
  /** Set when the agent is being invoked to undo a previously-completed phase */
  rollback?: { undoing: string };
};

// ─── Agent Executor Interface ───────────────────────────────────────

export interface AgentExecutor {
  execute(
    agent: AgentDef,
    input: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<{ output: Record<string, unknown>; metrics?: ExecutionMetrics }>;
}

// Factory che risolve l'executor giusto per ogni agente (in base al suo model)
export type ExecutorResolver = (agent: AgentDef) => AgentExecutor;

// ─── Mock Agent Executor ────────────────────────────────────────────

export class MockAgentExecutor implements AgentExecutor {
  private iterationCount = 0;

  setIteration(n: number): void {
    this.iterationCount = n;
  }

  async execute(
    agent: AgentDef,
    _input: Record<string, unknown>,
  ): Promise<{ output: Record<string, unknown>; metrics?: ExecutionMetrics }> {
    // Simulate slow agents (useful to exercise async paths end-to-end)
    const delay = Number(process.env.AGENTFLOW_MOCK_DELAY_MS ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const output: Record<string, unknown> = {};

    if (agent.must_produce) {
      for (const item of agent.must_produce) {
        if (item.name === 'verdict') {
          output[item.name] = this.iterationCount >= 2 ? 'approved' : 'needs_work';
        } else if (item.name === 'confidence') {
          output[item.name] = this.iterationCount >= 2 ? 0.9 : 0.5;
        } else {
          output[item.name] = this.mockValue(item.type);
        }
      }
    }

    return { output };
  }

  private mockValue(type?: string): unknown {
    switch (type) {
      case 'bool':
        return true;
      case 'float':
        return 0.9;
      case 'int':
        return 42;
      case 'datetime':
        return new Date().toISOString();
      case 'date':
        return new Date().toISOString().split('T')[0];
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        return 'mock_value';
    }
  }
}

// ─── Workflow Runner ────────────────────────────────────────────────

export class WorkflowRunner {
  private ir: WorkflowIR;
  private resolveExecutor: ExecutorResolver;
  private outputDir?: string;
  /** Directory for `<uuid>.state.json` files. Defaults to the CWD (back-compat). */
  private stateDir?: string;
  private aborted = false;
  private approveIrreversible: boolean;
  /** Set when execution stops at an unapproved irreversible phase */
  private gatedPhase: string | null = null;
  /** Set when execution stops waiting for a human_action_required phase */
  private awaitingUserPhase: string | null = null;
  /** Set when the accumulated cost exceeds the workflow's max_cost */
  private budgetExceeded: string | null = null;
  /** Human-supplied outputs for human_action_required phases, keyed by phase id */
  private userInputs: Record<string, Record<string, unknown>>;

  constructor(
    ir: WorkflowIR,
    executor: AgentExecutor | ExecutorResolver,
    options?: {
      outputDir?: string;
      stateDir?: string;
      approveIrreversible?: boolean;
      userInputs?: Record<string, Record<string, unknown>>;
    },
  ) {
    this.ir = ir;
    this.resolveExecutor = typeof executor === 'function' ? executor : () => executor;
    this.outputDir = options?.outputDir;
    this.stateDir = options?.stateDir;
    this.approveIrreversible = options?.approveIrreversible ?? false;
    this.userInputs = options?.userInputs ?? {};
  }

  /** Absolute-or-relative path of the state file for an instance, honoring stateDir. */
  private stateFilePath(instanceId: string): string {
    const name = `${instanceId}.state.json`;
    return this.stateDir ? join(this.stateDir, name) : name;
  }

  /** Register signal handlers for graceful shutdown. Call once before run(). */
  enableGracefulShutdown(): void {
    const handler = () => {
      logger.warn('Shutdown signal received — completing current phase then stopping');
      this.aborted = true;
    };
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  }

  async run(triggerInput: Record<string, unknown>): Promise<WorkflowInstance> {
    return this.start(triggerInput).done;
  }

  /**
   * Start a workflow without awaiting completion. Returns the live instance
   * (mutated as execution progresses — safe to poll for status) and a promise
   * that settles when the workflow finishes.
   */
  start(triggerInput: Record<string, unknown>): {
    instance: WorkflowInstance;
    done: Promise<WorkflowInstance>;
  } {
    const instance = this.createInstance(triggerInput);
    return { instance, done: this.execute(instance) };
  }

  async resume(instanceId: string): Promise<WorkflowInstance> {
    return this.resumeStart(instanceId).done;
  }

  /** Non-blocking variant of resume(): returns the live instance + completion promise. */
  resumeStart(instanceId: string): {
    instance: WorkflowInstance;
    done: Promise<WorkflowInstance>;
  } {
    const instance = this.loadState(instanceId);

    if (instance.workflow_id !== this.ir.workflow.id) {
      throw new Error(
        `workflow_id mismatch: state has "${instance.workflow_id}", IR has "${this.ir.workflow.id}"`,
      );
    }
    if (instance.state === 'completed') {
      throw new Error(`instance "${instanceId}" is already completed`);
    }

    instance.state = 'running';
    return { instance, done: this.execute(instance) };
  }

  private createInstance(triggerInput: Record<string, unknown>): WorkflowInstance {
    const instance: WorkflowInstance = {
      instance_id: randomUUID(),
      workflow_id: this.ir.workflow.id,
      state: 'pending',
      trigger_input: triggerInput,
      phase_states: {},
      phase_outputs: {},
      loop_iterations: {},
      loop_feedback: {},
      started_at: new Date().toISOString(),
    };

    for (const phase of this.ir.workflow.phases) {
      instance.phase_states[phase.id] = 'pending';
    }

    return instance;
  }

  private async execute(instance: WorkflowInstance): Promise<WorkflowInstance> {
    instance.state = 'running';

    try {
      const loop = this.ir.workflow.loop;
      const loopPhaseIds = new Set(loop?.phases ?? []);

      const stopped = () =>
        this.aborted || this.gatedPhase || this.awaitingUserPhase || this.budgetExceeded;

      // Execute non-loop phases that come before loop phases
      for (const phase of this.ir.workflow.phases) {
        if (stopped()) break;
        if (loopPhaseIds.has(phase.id)) continue;
        if (instance.phase_states[phase.id] === 'completed') continue;

        const phaseIdx = this.ir.workflow.phases.indexOf(phase);
        const firstLoopPhaseIdx = loop
          ? this.ir.workflow.phases.findIndex((p) => loopPhaseIds.has(p.id))
          : -1;

        if (firstLoopPhaseIdx === -1 || phaseIdx < firstLoopPhaseIdx) {
          await this.executePhase(phase, instance);
        }
      }

      // Execute loop if present
      if (loop && !stopped()) {
        await this.executeLoop(loop, instance);
      }

      // Execute non-loop phases that come after loop phases
      for (const phase of this.ir.workflow.phases) {
        if (stopped()) break;
        if (loopPhaseIds.has(phase.id)) continue;
        if (instance.phase_states[phase.id] === 'completed') continue;
        await this.executePhase(phase, instance);
      }

      if (this.budgetExceeded) {
        instance.state = 'failed';
        this.trackFailedStep(instance, 'budget', `Budget exceeded — ${this.budgetExceeded}`);
        logger.error(`[budget] Workflow aborted — ${this.budgetExceeded}`);
        return instance;
      }

      if (this.awaitingUserPhase) {
        instance.state = 'paused';
        const phase = this.ir.workflow.phases.find((p) => p.id === this.awaitingUserPhase);
        const instr = phase?.instruction_to_user?.message ?? 'Human action required';
        logger.warn(
          `[human] Phase "${this.awaitingUserPhase}" requires human action: ${instr}. ` +
            `Workflow paused (instance ${instance.instance_id}). ` +
            `Resume providing the phase outputs to continue.`,
        );
        return instance;
      }

      if (this.gatedPhase) {
        instance.state = 'paused';
        const receipt = this.getOrCreateReceipt(instance);
        receipt.execution_log.push({
          phase_id: this.gatedPhase,
          timestamp: new Date().toISOString(),
          state: 'gated',
        });
        logger.warn(
          `[gate] Phase "${this.gatedPhase}" is marked irreversible and approval was not granted. ` +
            `Workflow paused (instance ${instance.instance_id}). ` +
            `Resume with explicit approval to execute it.`,
        );
        return instance;
      }

      if (this.aborted) {
        instance.state = 'paused';
        logger.info(`Workflow paused — can be resumed with instance ID ${instance.instance_id}`);
        return instance;
      }

      // Evaluate done_when
      if (this.ir.workflow.done_when) {
        const done = this.evaluateCondition(this.ir.workflow.done_when, instance);
        instance.state = done ? 'completed' : 'failed';
        if (!done) {
          this.logConditionFailure(this.ir.workflow.done_when, instance);
        }
      } else {
        instance.state = 'completed';
      }
    } catch (err) {
      instance.state = 'failed';
      throw err;
    } finally {
      instance.completed_at = new Date().toISOString();

      // Compute resumability
      const receipt = instance.execution_receipt;
      if (receipt) {
        receipt.resumable = instance.state === 'paused' || instance.state === 'failed';
        if (receipt.resumable) {
          // Find first non-completed phase as resume point
          for (const phase of this.ir.workflow.phases) {
            if (instance.phase_states[phase.id] !== 'completed') {
              receipt.resume_from_phase = phase.id;
              break;
            }
          }
        }
      }

      this.saveState(instance);
      this.writeManifest(instance);
    }

    return instance;
  }

  private async executePhase(
    phase: PhaseDef,
    instance: WorkflowInstance,
    context?: ExecutionContext,
  ): Promise<void> {
    // Human-in-the-loop: a human_action_required phase is satisfied by human-provided
    // outputs (passed on resume), otherwise it pauses the workflow for human action.
    if (phase.type === 'human_action_required') {
      const provided = this.userInputs[phase.id];
      if (provided) {
        instance.phase_outputs[phase.id] = { ...provided };
        instance.phase_states[phase.id] = 'completed';
        this.pushExecutionStep(instance, {
          phase_id: phase.id,
          iteration: context?.loop?.iteration,
          timestamp: new Date().toISOString(),
          state: 'completed',
        });
        this.saveState(instance);
        this.writePhaseOutput(phase.id, instance.phase_outputs[phase.id], instance);
        return;
      }
      this.awaitingUserPhase = phase.id;
      instance.phase_states[phase.id] = 'awaiting_user';
      this.pushExecutionStep(instance, {
        phase_id: phase.id,
        iteration: context?.loop?.iteration,
        timestamp: new Date().toISOString(),
        state: 'awaiting_user',
        error: phase.instruction_to_user?.message,
      });
      return;
    }

    // Irreversibility gate: never execute an irreversible phase without explicit approval
    if (phase.irreversible && !this.approveIrreversible) {
      this.gatedPhase = phase.id;
      return;
    }

    const agent = this.ir.workflow.agents[phase.agent];
    if (!agent) {
      throw new Error(`Agent "${phase.agent}" not found for phase "${phase.id}"`);
    }

    instance.phase_states[phase.id] = 'running';

    // Resolve inputs
    const input = this.resolveInputs(phase.input ?? [], instance, phase.id);

    // Log feedback se presente
    if (input['feedback']) {
      logger.info(
        `[${phase.agent}] Feedback ricevuto: ${JSON.stringify(input['feedback']).slice(0, 100)}`,
      );
    }

    // Resolve inject_context: read referenced file and attach to execution context
    const resolvedContext = this.resolveInjectedContext(agent.inject_context, context);

    // Risolvi l'executor giusto per questo agente (in base al suo model)
    const executor = this.resolveExecutor(agent);

    // Track execution start
    const loopIter = context?.loop?.iteration;
    this.pushExecutionStep(instance, {
      phase_id: phase.id,
      iteration: loopIter,
      timestamp: new Date().toISOString(),
      state: 'started',
    });

    try {
      // Execute agent
      const { output, metrics } = await executor.execute(agent, input, resolvedContext);

      // Track tool calls
      if (metrics) {
        const receipt = this.getOrCreateReceipt(instance);
        receipt.tool_calls[phase.id] = {
          count: metrics.tool_calls,
          names: metrics.tool_names,
        };
        // Record per-phase token usage/cost for the receipt
        if (metrics.usage || metrics.cost_usd !== undefined) {
          if (!receipt.usage) receipt.usage = {};
          receipt.usage[phase.id] = {
            prompt_tokens: metrics.usage?.prompt_tokens ?? 0,
            completion_tokens: metrics.usage?.completion_tokens ?? 0,
            cost_usd: metrics.cost_usd,
            model: metrics.model,
          };
        }
        // Accumulate cost; enforce the workflow budget after the phase completes
        this.accumulateCost(instance, metrics.cost_usd, `phase "${phase.id}"`);
      }

      // Verify must_produce — fill missing fields with defaults instead of crashing
      if (agent.must_produce) {
        const missing = agent.must_produce
          .filter((item) => !(item.name in output))
          .map((item) => item.name);

        if (missing.length > 0) {
          logger.warn(
            `[${agent.id}] missing output fields: ${missing.join(', ')} — using defaults`,
          );
          for (const name of missing) {
            const item = agent.must_produce.find((m) => m.name === name);
            output[name] = item?.type === 'float' || item?.type === 'int' ? 0 : '';
          }
        }
      }

      // JSON Schema validation
      if (agent.output_schema) {
        const validationResult = await this.validateAndRetry(
          agent,
          input,
          output,
          resolvedContext,
          phase.id,
          instance,
        );
        if (validationResult === 'abort') {
          instance.phase_states[phase.id] = 'failed';
          const errMsg = `Phase "${phase.id}" aborted: output failed schema validation after retries`;
          this.trackFailedStep(instance, phase.id, errMsg, loopIter);
          this.pushExecutionStep(instance, {
            phase_id: phase.id,
            iteration: loopIter,
            timestamp: new Date().toISOString(),
            state: 'failed',
            error: errMsg,
          });
          throw new Error(errMsg);
        }
        // Merge validated output back
        Object.assign(output, validationResult === 'default' ? output : validationResult);
      }

      // Save output
      instance.phase_outputs[phase.id] = output;
      instance.phase_states[phase.id] = 'completed';

      // Track execution completion
      this.pushExecutionStep(instance, {
        phase_id: phase.id,
        iteration: loopIter,
        timestamp: new Date().toISOString(),
        state: 'completed',
      });

      this.saveState(instance);
      this.writePhaseOutput(phase.id, output, instance);
    } catch (err) {
      const errMsg = (err as Error).message;
      this.trackFailedStep(instance, phase.id, errMsg, loopIter);
      this.pushExecutionStep(instance, {
        phase_id: phase.id,
        iteration: loopIter,
        timestamp: new Date().toISOString(),
        state: 'failed',
        error: errMsg,
      });

      // rollback_on_fail: undo previously-completed phases (in declared order)
      if (phase.rollback_on_fail?.undo?.length) {
        await this.runRollback(phase, instance);
      }

      throw err;
    }
  }

  /**
   * Execute the rollback sequence declared by a failed phase.
   * Each undo target's agent is re-invoked with a rollback directive so it can
   * reverse the phase's side effects (e.g. an agent with shell_exec can deprovision).
   */
  private async runRollback(failedPhase: PhaseDef, instance: WorkflowInstance): Promise<void> {
    const undo = failedPhase.rollback_on_fail?.undo ?? [];
    logger.warn(
      `[rollback] Phase "${failedPhase.id}" failed — undoing: ${undo.join(', ')} (in order)`,
    );

    for (const targetId of undo) {
      const target = this.ir.workflow.phases.find((p) => p.id === targetId);
      if (!target) {
        logger.warn(`[rollback] undo target "${targetId}" is not a defined phase — skipping`);
        continue;
      }
      // Only undo phases that actually ran
      if (instance.phase_states[targetId] !== 'completed') {
        logger.info(`[rollback] skipping "${targetId}" — was not completed`);
        continue;
      }

      const agent = this.ir.workflow.agents[target.agent];
      if (!agent) {
        logger.warn(`[rollback] agent "${target.agent}" for "${targetId}" not found — skipping`);
        continue;
      }

      try {
        const executor = this.resolveExecutor(agent);
        const rollbackContext: ExecutionContext = { rollback: { undoing: targetId } };
        const input = this.resolveInputs(target.input ?? [], instance, targetId);
        await executor.execute(agent, input, rollbackContext);
        instance.phase_states[targetId] = 'rolled_back';
        this.pushExecutionStep(instance, {
          phase_id: targetId,
          timestamp: new Date().toISOString(),
          state: 'rolled_back',
        });
        logger.info(`[rollback] "${targetId}" rolled back`);
      } catch (rbErr) {
        logger.error(`[rollback] failed to undo "${targetId}": ${(rbErr as Error).message}`);
        this.pushExecutionStep(instance, {
          phase_id: targetId,
          timestamp: new Date().toISOString(),
          state: 'failed',
          error: `rollback failed: ${(rbErr as Error).message}`,
        });
      }
    }
  }

  private async validateAndRetry(
    agent: AgentDef,
    input: Record<string, unknown>,
    initialOutput: Record<string, unknown>,
    context: ExecutionContext | undefined,
    _phaseId: string,
    instance: WorkflowInstance,
  ): Promise<Record<string, unknown> | 'abort' | 'default'> {
    const schema = agent.output_schema!;
    const retries = agent.validation?.retry ?? 0;
    const onFail = agent.validation?.on_fail ?? 'default';

    let current = initialOutput;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const errors = validateJsonSchema(current, schema);
      if (errors.length === 0) {
        if (attempt > 0) {
          logger.info(`[${agent.id}] output passed schema validation after ${attempt} retry(s)`);
        }
        return current;
      }

      const errorSummary = errors.slice(0, 3).join('; ');
      logger.warn(
        `[${agent.id}] schema validation failed (attempt ${attempt + 1}/${retries + 1}): ${errorSummary}`,
      );

      if (attempt < retries) {
        // Budget gate: never spend money on another retry once max_cost is
        // exceeded — the workflow is going to abort anyway.
        if (this.budgetExceeded) {
          logger.warn(
            `[${agent.id}] skipping remaining validation retries — ${this.budgetExceeded}`,
          );
          break;
        }
        const retryInput = {
          ...input,
          _validation_errors: errorSummary,
          _previous_output: JSON.stringify(current),
          _retry_instruction: `Your previous output failed validation. Fix these errors and produce valid JSON output:\n${errorSummary}`,
        };
        const executor = this.resolveExecutor(agent);
        const retryResult = await executor.execute(agent, retryInput, context);
        current = retryResult.output;
        // Track tool calls and cost from retry
        if (retryResult.metrics) {
          const receipt = this.getOrCreateReceipt(instance);
          const existing = receipt.tool_calls[agent.id] ?? { count: 0 };
          receipt.tool_calls[agent.id] = {
            count: existing.count + retryResult.metrics.tool_calls,
            names: [...(existing.names ?? []), ...(retryResult.metrics.tool_names ?? [])],
          };
          // Retries cost real money too — count them toward total_cost_usd
          // and enforce the budget exactly like the main phase path.
          this.accumulateCost(
            instance,
            retryResult.metrics.cost_usd,
            `validation retry ${attempt + 1} of phase "${_phaseId}"`,
          );
        }

        // Track retry in execution log
        this.pushExecutionStep(instance, {
          phase_id: _phaseId,
          iteration: context?.loop?.iteration,
          timestamp: new Date().toISOString(),
          state: 'retry',
          error: errorSummary,
        });
      }
    }

    if (onFail === 'abort') {
      return 'abort';
    }
    return 'default';
  }

  private async executeLoop(
    loop: import('./types.js').LoopDef,
    instance: WorkflowInstance,
  ): Promise<void> {
    const maxIter = loop.max_iterations ?? Infinity;
    const startIteration = instance.loop_iterations[loop.id] ?? 0;
    let iteration = startIteration > 0 ? startIteration - 1 : 0;
    if (startIteration === 0) instance.loop_iterations[loop.id] = 0;

    // Get ordered loop phases
    const loopPhases = loop.phases
      .map((id) => this.ir.workflow.phases.find((p) => p.id === id))
      .filter((p): p is PhaseDef => p !== undefined);

    do {
      if (this.aborted || this.gatedPhase || this.awaitingUserPhase || this.budgetExceeded) break;
      iteration++;
      instance.loop_iterations[loop.id] = iteration;

      // Set iteration on mock executor if applicable
      // Try with the first agent in the loop to check if it's a MockAgentExecutor
      const firstLoopAgent = this.ir.workflow.agents[loopPhases[0]?.agent];
      if (firstLoopAgent) {
        const testExecutor = this.resolveExecutor(firstLoopAgent);
        if (testExecutor instanceof MockAgentExecutor) {
          testExecutor.setIteration(iteration);
        }
      }

      // Execute each phase in the loop
      for (const phase of loopPhases) {
        // During a resume iteration, skip already-completed phases
        if (iteration === startIteration && instance.phase_states[phase.id] === 'completed') {
          continue;
        }
        instance.phase_states[phase.id] = 'pending';

        // Inject loop feedback as extra input
        if (
          iteration > 1 &&
          loop.on_each_iteration &&
          phase.agent === loop.on_each_iteration.send_to
        ) {
          const payloadRef = loop.on_each_iteration.payload;
          if (payloadRef) {
            // "phase.field" → resolve as reference; anything else is a literal message
            const isRef = /^[A-Za-z_]\w*\.[A-Za-z_][\w.]*$/.test(payloadRef);
            const feedbackValue = isRef
              ? this.resolveValue({ kind: 'ref', path: payloadRef } as ValueExpr, instance)
              : payloadRef;
            if (!instance.loop_feedback) instance.loop_feedback = {};
            instance.loop_feedback[phase.id] = feedbackValue;
          }
        }

        const loopContext: ExecutionContext = {
          loop: {
            iteration,
            max_iterations: maxIter === Infinity ? undefined : maxIter,
            acceptance_criteria: this.ir.workflow.done_when
              ? this.conditionToText(this.ir.workflow.done_when)
              : undefined,
          },
        };
        await this.executePhase(phase, instance, loopContext);
        if (this.gatedPhase || this.awaitingUserPhase || this.budgetExceeded) return;
      }

      // Early exit: if done_when is already satisfied, break immediately
      if (this.ir.workflow.done_when) {
        const doneEarly = this.evaluateCondition(this.ir.workflow.done_when, instance);
        if (doneEarly) {
          logger.info(
            `[loop:${loop.id}] done_when satisfied at iteration ${iteration} — exiting early`,
          );
          break;
        }
      }

      // Evaluate repeat_while
      if (loop.repeat_while) {
        const shouldRepeat = this.evaluateCondition(loop.repeat_while, instance);
        if (!shouldRepeat) break;
      } else {
        break;
      }

      if (iteration >= maxIter) {
        if (loop.on_max_exceeded) {
          console.error(
            `[loop:${loop.id}] Max iterations (${maxIter}) exceeded. ` +
              `Escalating to: ${loop.on_max_exceeded.escalate_to ?? 'unknown'}. ` +
              `Message: ${loop.on_max_exceeded.message ?? ''}`,
          );
        }
        break;
      }
    } while (true);
  }

  private resolveInputs(
    inputRefs: string[],
    instance: WorkflowInstance,
    phaseId?: string,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const ref of inputRefs) {
      const parts = ref.split('.');
      if (parts[0] === 'trigger') {
        const key = parts.slice(1).join('.');
        result[key] = instance.trigger_input[key];
      } else {
        // phase.field reference
        const phaseId = parts[0];
        const field = parts.slice(1).join('.');
        const phaseOutput = instance.phase_outputs[phaseId];
        if (phaseOutput && field) {
          result[field] = phaseOutput[field];
        } else if (phaseOutput) {
          Object.assign(result, phaseOutput);
        }
      }
    }

    // Inject loop feedback if present for this phase
    if (phaseId && instance.loop_feedback?.[phaseId]) {
      result['feedback'] = instance.loop_feedback[phaseId];
      result['improvement_list'] = instance.loop_feedback[phaseId];
    }

    return result;
  }

  private evaluateCondition(condition: Condition, instance: WorkflowInstance): boolean {
    switch (condition.kind) {
      case 'compare': {
        const left = this.resolveValue(condition.left, instance);
        const right = this.resolveValue(condition.right, instance);

        switch (condition.op) {
          case '==':
            return left === right;
          case '!=':
            return left !== right;
          case '>':
            return Number(left) > Number(right);
          case '<':
            return Number(left) < Number(right);
          case '>=':
            return Number(left) >= Number(right);
          case '<=':
            return Number(left) <= Number(right);
          default:
            return false;
        }
      }
      case 'and':
        return condition.conditions.every((c) => this.evaluateCondition(c, instance));
      case 'or':
        return condition.conditions.some((c) => this.evaluateCondition(c, instance));
      case 'not':
        return !this.evaluateCondition(condition.condition, instance);
      default:
        return false;
    }
  }

  private resolveValue(expr: ValueExpr, instance: WorkflowInstance): unknown {
    if (expr.kind === 'literal') {
      return expr.value;
    }

    // Ref resolution
    const parts = expr.path.split('.');
    if (parts[0] === 'trigger') {
      return instance.trigger_input[parts.slice(1).join('.')];
    }

    // Check phase outputs first
    const phaseOutput = instance.phase_outputs[parts[0]];
    if (phaseOutput) {
      return phaseOutput[parts.slice(1).join('.')];
    }

    // Check agent-named outputs (e.g. health_checker.domain_resolves)
    // Look through all phase outputs for a phase that uses this agent
    for (const phase of this.ir.workflow.phases) {
      if (phase.agent === parts[0] && instance.phase_outputs[phase.id]) {
        return instance.phase_outputs[phase.id][parts.slice(1).join('.')];
      }
    }

    return undefined;
  }

  private loadState(instanceId: string): WorkflowInstance {
    // Validate the instance id is a UUID before touching the filesystem —
    // prevents path traversal via crafted instance ids (e.g. "../../etc/passwd").
    if (!UUID_RE.test(instanceId)) {
      throw new Error(`invalid instance id "${instanceId}" (must be a UUID)`);
    }
    let raw: string;
    try {
      raw = readFileSync(this.stateFilePath(instanceId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`state file not found for instance "${instanceId}"`);
      }
      throw new Error(`failed to load state for "${instanceId}": ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`corrupted state file for "${instanceId}": ${(err as Error).message}`);
    }

    if (!isValidInstanceShape(parsed)) {
      throw new Error(`state file for "${instanceId}" failed structural validation`);
    }
    // Defense in depth: the on-disk id must match the requested id.
    if ((parsed as WorkflowInstance).instance_id !== instanceId) {
      throw new Error(`state file instance_id mismatch for "${instanceId}"`);
    }
    return parsed as WorkflowInstance;
  }

  private writePhaseOutput(
    phaseId: string,
    output: Record<string, unknown>,
    instance: WorkflowInstance,
  ): void {
    if (!this.outputDir) return;
    try {
      mkdirSync(this.outputDir, { recursive: true });

      // Write full phase output as JSON
      const outPath = join(this.outputDir, `${phaseId}.json`);
      writeFileSync(outPath, JSON.stringify(output, null, 2));
      this.recordFileWritten(instance, outPath);

      // Extract code fields as standalone files
      if (typeof output['code'] === 'string') {
        const codePath = join(this.outputDir, `${phaseId}.code.ts`);
        writeFileSync(codePath, output['code']);
        this.recordFileWritten(instance, codePath);
      }
    } catch {
      // Non-critical — don't break workflow for output persistence
    }
  }

  private writeManifest(instance: WorkflowInstance): void {
    if (!this.outputDir) return;
    try {
      mkdirSync(this.outputDir, { recursive: true });
      const manifest = {
        instance_id: instance.instance_id,
        workflow_id: instance.workflow_id,
        state: instance.state,
        started_at: instance.started_at,
        completed_at: instance.completed_at,
        phases: Object.keys(instance.phase_states).map((id) => ({
          id,
          state: instance.phase_states[id],
          outputs: Object.keys(instance.phase_outputs[id] ?? {}),
        })),
      };
      const manifestPath = join(this.outputDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      this.recordFileWritten(instance, manifestPath);
    } catch {
      // Non-critical
    }
  }

  private resolveInjectedContext(
    injectKey: string | undefined,
    baseContext?: ExecutionContext,
  ): ExecutionContext | undefined {
    if (!injectKey) return baseContext;

    // Try direct file path first
    try {
      const content = readFileSync(injectKey, 'utf-8');
      return { ...baseContext, injectedContext: content };
    } catch {
      // Not a direct path — fall back to workflow context key lookup
    }

    const workflowContext = this.ir.workflow.context as Record<string, unknown> | undefined;
    const filePath = workflowContext?.[injectKey];

    if (typeof filePath !== 'string') {
      logger.warn(
        `[inject_context] "${injectKey}" is not a valid file path or workflow context key — skipping`,
      );
      return baseContext;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      return { ...baseContext, injectedContext: content };
    } catch {
      logger.warn(`[inject_context] file "${filePath}" not found — skipping`);
      return baseContext;
    }
  }

  private conditionToText(condition: Condition): string {
    switch (condition.kind) {
      case 'compare': {
        const left =
          condition.left.kind === 'ref' ? condition.left.path : String(condition.left.value);
        const right =
          condition.right.kind === 'ref' ? condition.right.path : String(condition.right.value);
        return `${left} ${condition.op} ${right}`;
      }
      case 'and':
        return condition.conditions.map((c) => this.conditionToText(c)).join(' AND ');
      case 'or':
        return condition.conditions.map((c) => this.conditionToText(c)).join(' OR ');
      case 'not':
        return `NOT (${this.conditionToText(condition.condition)})`;
    }
  }

  private logConditionFailure(condition: Condition, instance: WorkflowInstance, prefix = ''): void {
    if (condition.kind === 'compare') {
      const left = this.resolveValue(condition.left, instance);
      const right = this.resolveValue(condition.right, instance);
      const passed = this.evaluateCondition(condition, instance);
      if (!passed) {
        const leftLabel =
          condition.left.kind === 'ref'
            ? condition.left.path
            : JSON.stringify(condition.left.value);
        const rightLabel =
          condition.right.kind === 'ref'
            ? condition.right.path
            : JSON.stringify(condition.right.value);
        logger.warn(
          `[done_when] ${prefix}${leftLabel} ${condition.op} ${rightLabel} → ${JSON.stringify(left)} ${condition.op} ${JSON.stringify(right)} = false`,
        );
      }
    } else if (condition.kind === 'and') {
      for (const c of condition.conditions) {
        this.logConditionFailure(c, instance, prefix);
      }
    } else if (condition.kind === 'or') {
      logger.warn(`[done_when] ${prefix}OR block failed (all conditions false):`);
      for (const c of condition.conditions) {
        this.logConditionFailure(c, instance, prefix + '  ');
      }
    } else if (condition.kind === 'not') {
      this.logConditionFailure(condition.condition, instance, prefix + 'NOT ');
    }
  }

  private saveState(instance: WorkflowInstance): void {
    try {
      if (this.stateDir) mkdirSync(this.stateDir, { recursive: true });
      const filename = this.stateFilePath(instance.instance_id);
      writeFileSync(filename, JSON.stringify(instance, null, 2));

      // Track checkpoint
      const receipt = this.getOrCreateReceipt(instance);
      const lastCompleted = Object.entries(instance.phase_states)
        .filter(([, s]) => s === 'completed')
        .map(([id]) => id)
        .pop();
      receipt.checkpoints.push({
        phase_id: lastCompleted ?? 'start',
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Silent fail for state persistence — it's non-critical
    }
  }

  // ─── Execution Receipt Helpers ────────────────────────────────────

  private getOrCreateReceipt(instance: WorkflowInstance): ExecutionReceipt {
    if (!instance.execution_receipt) {
      instance.execution_receipt = {
        execution_log: [],
        tool_calls: {},
        side_effects: { files_written: [] },
        checkpoints: [],
        failed_steps: [],
        resumable: false,
      };
    }
    return instance.execution_receipt;
  }

  private pushExecutionStep(instance: WorkflowInstance, step: ExecutionStep): void {
    this.getOrCreateReceipt(instance).execution_log.push(step);
  }

  /** Record a written file, deduplicating paths rewritten across loop iterations. */
  private recordFileWritten(instance: WorkflowInstance, path: string): void {
    const written = this.getOrCreateReceipt(instance).side_effects.files_written;
    if (!written.includes(path)) written.push(path);
  }

  private trackFailedStep(
    instance: WorkflowInstance,
    phaseId: string,
    error: string,
    iteration?: number,
  ): void {
    this.getOrCreateReceipt(instance).failed_steps.push({
      phase_id: phaseId,
      error,
      iteration,
    });
  }

  /**
   * Add an invocation's cost to the receipt total and flag the workflow for
   * abort when `max_cost` is exceeded. Used for phase executions AND
   * validation retries — every paid call counts toward the budget.
   */
  private accumulateCost(
    instance: WorkflowInstance,
    costUsd: number | undefined,
    label: string,
  ): void {
    if (costUsd === undefined) return;
    const receipt = this.getOrCreateReceipt(instance);
    receipt.total_cost_usd = (receipt.total_cost_usd ?? 0) + costUsd;
    const budget = this.ir.workflow.max_cost;
    if (budget !== undefined && receipt.total_cost_usd > budget && !this.budgetExceeded) {
      this.budgetExceeded =
        `cost $${receipt.total_cost_usd.toFixed(4)} exceeds max_cost ` +
        `$${budget.toFixed(4)} after ${label}`;
    }
  }
}
