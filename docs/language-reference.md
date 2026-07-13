# Language Reference

AgentFlow DSL is a declarative, indentation-based language for defining multi-agent AI workflows.

## File Extension

`.aflow` — plain text, git-friendly.

## Structure

```aflow
workflow <id>
  description: "<text>"
  version: "<semver>"

  context:           # optional
    <key>: "<value>"

  agents:
    agent <id>
      model: "<alias>"
      mode: <mode>
      tools: [<name>, ...]
      must_produce:
        - <name>
        - <name>: <type>
      constraint: "<rule>"
      rule: "<rule>"

  phases:
    phase <id>
      agent: <agent_id>
      input: [<ref>, ...]
      output: [<name>, ...]
      inject_context: "<path or context key>"
      timeout: <duration>

  loop <id>           # optional
    phases: [<phase_id>, ...]
    repeat_while: <condition>
    max_iterations: <n>
    on_each_iteration:
      send_to: <agent_id>
      payload: <ref>

  done when: <condition>  # optional
```

## Workflow

```aflow
workflow <id>
  description: "<text>"
  version: "<semver>"
  max_cost: <usd>          # optional — abort if accumulated agent cost exceeds this
```

- `id` — unique identifier, snake_case
- `description` — human-readable (shown in CLI and MCP tool description)
- `version` — semantic versioning
- `max_cost` — optional spend cap in USD. The workflow aborts (`state: failed`) once total agent cost exceeds it. Requires executors that report cost (e.g. `agent-sdk`); cost is accumulated in the execution receipt's `total_cost_usd`.

## Agents

```aflow
agent <id>
  model: "<alias>"     # from agentflow.config.json, default: "auto"
  mode: <mode>         # focused | adversarial | reliable | precise | strict | patient | objective
  tools: [<name>, ...] # built-in tools available to this agent
  must_produce:
    - <name>           # required output field (type: string)
    - <name>: float    # typed field (float, int, bool, array, object)
  constraint: "<rule>" # natural language constraint
  rule: "<rule>"       # additional rules (can repeat)
```

### Modes

| Mode | Behavior |
|---|---|
| `focused` | Focus exclusively on the task. No digressions. |
| `adversarial` | Find bugs and issues. Do not approve without evidence. |
| `reliable` | Correctness and idempotency. No shortcuts. |
| `precise` | Exact output. No ambiguity. No superfluous text. |
| `strict` | Apply all rules without exceptions. |
| `patient` | Analyze carefully before responding. |
| `objective` | Evaluate facts without bias. |

### Built-in Tools

| Tool | Description |
|---|---|
| `file_write` | Write content to a file |
| `file_read` | Read file content |
| `shell_exec` | Execute shell commands (30s timeout) |
| `test_runner` | Run TypeScript code in a temp file |

### Model Resolution

The `model` field references an alias from `agentflow.config.json`. The special alias `auto` resolves to the best available provider: Claude API key → OpenRouter → DeepSeek → Ollama.

## Phases

```aflow
phase <id>
  agent: <agent_id>
  input: [<ref>, ...]
  output: [<name>, ...]
  inject_context: "<path>"
  timeout: <duration>
  irreversible: true       # phase touches money/deploys/deletions — requires explicit approval
```

### irreversible

A phase marked `irreversible: true` never executes without explicit approval. Without it, the workflow **pauses at the gate** (`state: paused`, a `gated` event in the execution receipt) so the state can be reviewed first:

- CLI: `agentflow run … --approve-irreversible`, or resume a paused instance with `agentflow resume <file> --instance <uuid> --approve-irreversible`
- MCP: pass `approve_irreversible: true` in the tool call, or resume with the `agentflow_resume` tool

Validation S13 warns if an irreversible phase sits inside a loop — a single approval covers every iteration.

### human_action_required

A phase with `type: human_action_required` does not run an agent — it **pauses the workflow** for human input:

```aflow
phase approve
  agent: planner
  type: human_action_required
  instruction_to_user:
    message: "Approve the plan before deployment"
  input: [plan.plan]
  output: [approved]
```

The workflow pauses (`state: paused`, phase `awaiting_user`) and records the `instruction_to_user` message in the receipt. Resume by supplying the phase's outputs — via the runner's `userInputs` option — and execution continues with those values.

### rollback_on_fail

If a phase fails, `rollback_on_fail.undo` lists previously-completed phases to reverse:

```aflow
phase update_database
  agent: db_updater
  input: [provision.resource_id]
  output: [status]
  rollback_on_fail:
    undo: [configure_proxy, provision]
```

On failure, each completed undo target's agent is re-invoked in **rollback mode** (a directive tells the agent to reverse, not repeat, its action — useful for agents with `shell_exec` that can deprovision). Undone phases are marked `rolled_back` in the receipt; the workflow still fails.

### Input References

- `trigger.<key>` — workflow input passed via `--input`
- `<phase_id>.<output_name>` — output from a previous phase
- `<agent_id>.<output_name>` — output from any phase run by that agent

### Output

Fields declared in `output` are saved to the instance state and available as inputs to subsequent phases. The agent's `must_produce` must include all declared output fields.

### inject_context

Injects file content or a workflow `context:` value into the agent's system prompt:

```aflow
context:
  coding_rules: "coding-standards.md"

agent writer
  inject_context: coding_rules    # resolves to file content
  # or direct path:
  inject_context: "../README.md"
```

## Loops

```aflow
loop <id>
  phases: [<phase_id>, ...]
  repeat_while: <condition>
  max_iterations: <n>
  on_each_iteration:
    send_to: <agent_id>
    payload: <ref or literal>   # phase.field reference, or a literal feedback message
  on_max_exceeded:
    escalate_to: <agent_id>
    message: "<text>"
    attach: [<ref>, ...]
```

`payload` accepts either a `phase.field` reference (e.g. `edit.suggestions`) — resolved at each iteration — or any other string, passed verbatim as feedback to the `send_to` agent (e.g. `"Too short. Expand to at least 50 words."`).

- Phases must be contiguous in the workflow definition
- `repeat_while` is evaluated after each complete iteration
- `max_iterations` prevents infinite loops
- `on_each_iteration` passes feedback from the last phase back to the first
- `on_max_exceeded` handles graceful degradation

## Conditions

Used in `repeat_while` and `done when`:

```aflow
# Comparison operators: == != > < >= <=
review.verdict == "approved"
review.confidence >= 0.85

# Logical operators: and, or, not
review.verdict == "approved" and review.confidence >= 0.85
not (review.verdict == "needs_work")
```

## Complete Example

```aflow
workflow code_quality
  description: "Iterative code review"
  version: "1.0.0"

  context:
    rules_file: "coding-standards.md"

  agents:
    agent writer
      model: "local-fast"
      mode: focused
      tools: [file_write]
      must_produce:
        - user_story
        - code
        - progress_note
      inject_context: rules_file
      rule: "Follow project coding standards"
      rule: "Write clean, testable code"

    agent tester
      model: "openrouter-smart"
      mode: adversarial
      tools: [test_runner]
      must_produce:
        - test_results
        - edge_cases_tried
        - bug_report
      constraint: "Try to break the code with edge cases"

    agent critic
      model: "claude-sonnet"
      mode: adversarial
      must_produce:
        - verdict
        - improvement_list
        - confidence: float
      constraint: "Be critical and thorough in review"

  phases:
    phase write
      agent: writer
      input: [trigger.task]
      output: [user_story, code, progress_note]

    phase test
      agent: tester
      input: [write.code]
      output: [test_results, edge_cases_tried, bug_report]

    phase review
      agent: critic
      input: [write.code, test.test_results, test.bug_report]
      output: [verdict, improvement_list, confidence]

  loop quality_gate
    phases: [write, test, review]
    repeat_while: review.verdict == "needs_work"
    max_iterations: 10
    on_each_iteration:
      send_to: writer
      payload: review.improvement_list
    on_max_exceeded:
      escalate_to: human_reviewer
      message: "Quality gate exceeded max iterations"

  done when: review.confidence >= 0.85 and review.verdict == "approved"
```
