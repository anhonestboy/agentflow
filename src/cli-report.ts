import type { WorkflowInstance } from './types.js';

/**
 * CLI exit codes for `run`/`resume`. Documented in the README so scripts and
 * orchestrators (e.g. flow) can branch on them reliably.
 */
export const EXIT_COMPLETED = 0;
export const EXIT_FAILED = 1;
export const EXIT_PAUSED = 2;

export type RunReport = {
  /** Process exit code: 0 completed, 1 failed, 2 paused (gate/HITL). */
  exitCode: number;
  /** Human-readable summary lines to print after the phase results. */
  lines: string[];
};

export type ReportOptions = {
  /** The workflow file, used to render the resume command. */
  file: string;
  /** Which command produced the instance. */
  command: 'run' | 'resume';
};

/** Total token usage / cost across all phases in the receipt. */
export type UsageTotals = {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** True when at least one executor reported a dollar cost. */
  costKnown: boolean;
};

/** Sum the per-phase usage recorded in the execution receipt. */
export function usageTotals(instance: WorkflowInstance): UsageTotals {
  const receipt = instance.execution_receipt;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const u of Object.values(receipt?.usage ?? {})) {
    promptTokens += u.prompt_tokens ?? 0;
    completionTokens += u.completion_tokens ?? 0;
  }
  return {
    costUsd: receipt?.total_cost_usd ?? 0,
    promptTokens,
    completionTokens,
    costKnown: receipt?.total_cost_usd !== undefined,
  };
}

/**
 * A stable, parseable one-line cost summary, e.g.
 * `total_cost_usd=0.012300 total_prompt_tokens=4500 total_completion_tokens=1200 cost_known=true`
 */
export function formatCostLine(totals: UsageTotals): string {
  return (
    `total_cost_usd=${totals.costUsd.toFixed(6)} ` +
    `total_prompt_tokens=${totals.promptTokens} ` +
    `total_completion_tokens=${totals.completionTokens} ` +
    `cost_known=${totals.costKnown}`
  );
}

/**
 * Decide the exit code and summary lines for a finished/paused instance.
 *
 * - `completed`  → 0
 * - `paused`     → 2, with the resume command (gate/HITL distinguished)
 * - anything else (failed or an unexpected terminal state) → 1, with failed_steps
 */
export function buildRunReport(instance: WorkflowInstance, opts: ReportOptions): RunReport {
  const { file } = opts;
  const receipt = instance.execution_receipt;

  if (instance.state === 'completed') {
    return { exitCode: EXIT_COMPLETED, lines: ['✅ Workflow completed successfully.'] };
  }

  if (instance.state === 'paused') {
    const resumePhase = receipt?.resume_from_phase ?? '(unknown phase)';
    const awaitingUser = Object.values(instance.phase_states).includes('awaiting_user');
    // A gate leaves an explicit `gated` marker in the execution log. A signal
    // (SIGTERM/SIGINT) checkpoint also pauses, but must NOT be told to approve.
    const gated = (receipt?.execution_log ?? []).some((s) => s.state === 'gated');
    const lines: string[] = [];
    if (awaitingUser) {
      lines.push(`⏸  Workflow paused for human action at phase "${resumePhase}".`);
      lines.push('   Supply the phase outputs (see docs: human_action_required), then resume:');
      lines.push(`   agentflow resume ${file} --instance ${instance.instance_id}`);
    } else if (gated) {
      lines.push(`🛑 Workflow paused at gated phase "${resumePhase}" — approval required.`);
      lines.push('   Review the saved state, then resume with explicit approval:');
      lines.push(
        `   agentflow resume ${file} --instance ${instance.instance_id} --approve-irreversible`,
      );
    } else {
      lines.push(`⏸  Workflow paused (interrupted) at phase "${resumePhase}".`);
      lines.push('   Resume to continue from the last checkpoint:');
      lines.push(`   agentflow resume ${file} --instance ${instance.instance_id}`);
    }
    return { exitCode: EXIT_PAUSED, lines };
  }

  // failed, or an unexpected terminal state (running/pending should never reach here)
  const lines = [`❌ Workflow ${instance.state} — exiting ${EXIT_FAILED}.`];
  const failed = receipt?.failed_steps ?? [];
  if (failed.length > 0) {
    lines.push('   Failed steps:');
    for (const step of failed) {
      const iter = step.iteration !== undefined ? ` (iteration ${step.iteration})` : '';
      lines.push(`   - ${step.phase_id}${iter}: ${step.error}`);
    }
  }
  return { exitCode: EXIT_FAILED, lines };
}
