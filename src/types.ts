// ─── IR Types (compiled output) ───────────────────────────────────────

export type ValueExpr =
  | { kind: 'ref'; path: string }
  | { kind: 'literal'; value: string | number | boolean };

export type Condition =
  | {
      kind: 'compare';
      left: ValueExpr;
      op: '==' | '!=' | '>' | '<' | '>=' | '<=';
      right: ValueExpr;
    }
  | { kind: 'and'; conditions: Condition[] }
  | { kind: 'or'; conditions: Condition[] }
  | { kind: 'not'; condition: Condition };

export type Duration = { value: number; unit: 's' | 'min' | 'h' | 'd' };

export type MustProduceItem = {
  name: string;
  type?: string; // bool, string, int, float, datetime, date, object, array
};

export type JSONSchema = Record<string, unknown>;

export type ValidationConfig = {
  retry?: number; // max retries on validation failure (default 0)
  on_fail?: 'abort' | 'default'; // abort = stop workflow, default = fill defaults (backward compat)
};

export type AgentDef = {
  id: string;
  model?: string;
  mode: string; // focused, adversarial, reliable, etc.
  tools?: string[];
  must_produce?: MustProduceItem[];
  output_schema?: JSONSchema; // JSON Schema for output validation
  validation?: ValidationConfig; // retry/abort on validation failure
  inject_context?: string;
  fail_fast?: boolean;
  constraints?: string[];
  rules?: string[];
  has_side_effects?: boolean;
};

export type PollConfig = {
  interval?: Duration;
  backoff?: string; // exponential, linear, fixed
  max_wait?: Duration;
  condition?: Condition;
};

export type RetryConfig = {
  max_attempts?: number;
  backoff?: Duration | string;
  condition?: Condition;
  on_all_failed?: {
    escalate_to?: string;
    reschedule?: Duration;
  };
};

export type RollbackOnFail = {
  undo: string[];
};

export type OnFailConfig = {
  condition?: Condition;
  action?: string; // notify_user, abort
  message?: string;
  then?: string; // abort, continue
};

export type InstructionToUser = {
  message: string;
  data?: string;
  format?: string; // table, list, json, text
};

export type OnTimeoutConfig = {
  action?: string;
  then?: string;
};

export type PhaseDef = {
  id: string;
  agent: string;
  input?: string[];
  output?: string[];
  type: string; // standard, human_action_required, streaming_batch
  timeout?: Duration;
  /** Phase performs an irreversible action (money, deploy, delete) — runtime requires explicit approval */
  irreversible?: boolean;
  poll?: PollConfig;
  retry?: RetryConfig;
  rollback_on_fail?: RollbackOnFail;
  on_fail?: OnFailConfig;
  instruction_to_user?: InstructionToUser;
  completes_when?: string | Condition;
  on_timeout?: OnTimeoutConfig;
};

export type LoopDef = {
  id: string;
  phases: string[];
  repeat_while?: Condition;
  max_iterations?: number;
  on_each_iteration?: {
    send_to?: string;
    payload?: string;
  };
  on_max_exceeded?: {
    escalate_to?: string;
    message?: string;
    attach?: string[];
  };
};

export type TriggerDef = {
  on_event?: string;
  input?: Array<{ name: string; type: string }>;
};

export type RollbackConfig = {
  priority_order?: string[];
  notify_user?: boolean;
  log_to?: string;
};

export type OnSuccessConfig = {
  notify_user?: {
    message: string;
    attach?: string[];
  };
};

export type WorkflowIR = {
  $schema: string;
  $agentflow_version: string;
  compiled_at: string;
  workflow: {
    id: string;
    description?: string;
    version?: string;
    trigger?: TriggerDef;
    context?: Record<string, ValueExpr | string>;
    agents: Record<string, AgentDef>;
    phases: PhaseDef[];
    loop?: LoopDef;
    done_when?: Condition;
    rollback?: RollbackConfig;
    on_success?: OnSuccessConfig;
    /** Maximum total cost (USD) before the workflow aborts. Requires executors that report cost. */
    max_cost?: number;
  };
};

// ─── AST Types (parser output) ───────────────────────────────────────

export type ASTLiteral = {
  kind: 'literal';
  value: string | number | boolean;
  rawType: 'string' | 'number' | 'bool' | 'identifier';
};

export type ASTRef = {
  kind: 'ref';
  path: string; // dotted path, e.g. "review.verdict"
};

export type ASTList = {
  kind: 'list';
  items: ASTValue[];
};

export type ASTBlock = {
  kind: 'block';
  properties: ASTProperty[];
};

export type ASTCondition = {
  kind: 'condition';
  left: ASTValue;
  op: string;
  right: ASTValue;
  logic?: 'and' | 'or';
  next?: ASTCondition;
};

export type ASTValue = ASTLiteral | ASTRef | ASTList | ASTBlock | ASTCondition;

export type ASTProperty = {
  kind: 'property';
  key: string;
  value: ASTValue;
};

export type ASTAgent = {
  kind: 'agent';
  id: string;
  properties: ASTProperty[];
};

export type ASTPhase = {
  kind: 'phase';
  id: string;
  properties: ASTProperty[];
};

export type ASTLoop = {
  kind: 'loop';
  id: string;
  properties: ASTProperty[];
};

export type ASTWorkflow = {
  kind: 'workflow';
  id: string;
  properties: ASTProperty[];
  agents: ASTAgent[];
  phases: ASTPhase[];
  loop?: ASTLoop;
};

// ─── Validation Types ────────────────────────────────────────────────

export type ValidationIssue = {
  rule: string;
  message: string;
  phase?: string;
  agent?: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

// ─── Token Types ─────────────────────────────────────────────────────

export type TokenKind =
  | 'KEYWORD'
  | 'IDENTIFIER'
  | 'STRING'
  | 'NUMBER'
  | 'BOOL'
  | 'COLON'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'DOT'
  | 'PIPE'
  | 'COMMA'
  | 'INDENT'
  | 'DEDENT'
  | 'NEWLINE'
  | 'OPERATOR'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'DASH'
  | 'EOF';

export type Token = {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
};

// ─── Runtime Types ───────────────────────────────────────────────────

export type PhaseState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'awaiting_user'
  | 'rolled_back';
export type WorkflowState = 'pending' | 'running' | 'completed' | 'failed' | 'paused';

export type WorkflowInstance = {
  instance_id: string;
  workflow_id: string;
  state: WorkflowState;
  trigger_input: Record<string, unknown>;
  phase_states: Record<string, PhaseState>;
  phase_outputs: Record<string, Record<string, unknown>>;
  loop_iterations: Record<string, number>;
  loop_feedback?: Record<string, unknown>;
  started_at?: string;
  completed_at?: string;
  execution_receipt?: ExecutionReceipt;
};

// ─── Execution Receipt ──────────────────────────────────────────────

export type ExecutionStep = {
  phase_id: string;
  iteration?: number;
  timestamp: string;
  state: 'started' | 'completed' | 'failed' | 'retry' | 'gated' | 'awaiting_user' | 'rolled_back';
  error?: string;
};

/** Prompt/completion token counts reported by an executor for one invocation. */
export type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

/** Per-phase token usage and (when known) cost, recorded in the execution receipt. */
export type PhaseUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  /** USD cost for the phase, when the model's price is known; omitted otherwise */
  cost_usd?: number;
  /** Model that produced the usage (for auditing/pricing transparency) */
  model?: string;
};

export type ExecutionReceipt = {
  execution_log: ExecutionStep[];
  tool_calls: Record<string, { count: number; names?: string[] }>;
  /** Per-phase token usage/cost, for every executor that reports usage */
  usage?: Record<string, PhaseUsage>;
  side_effects: { files_written: string[] };
  checkpoints: { phase_id: string; timestamp: string; iteration?: number }[];
  failed_steps: { phase_id: string; error: string; iteration?: number }[];
  resumable: boolean;
  resume_from_phase?: string;
  /** Accumulated cost (USD) across all agent invocations, when reported by executors */
  total_cost_usd?: number;
};

export type ExecutionMetrics = {
  tool_calls: number;
  tool_names?: string[];
  /** Cost of this agent invocation in USD, if the executor reports it */
  cost_usd?: number;
  /** Prompt/completion token counts, if the executor reports them */
  usage?: TokenUsage;
  /** Model that produced this invocation (used for pricing/receipt) */
  model?: string;
};
