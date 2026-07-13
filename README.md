# AgentFlow DSL

**A declarative language for multi-agent AI workflows — compile to MCP tools, no glue code required.**

[![npm version](https://img.shields.io/npm/v/@anhonestboy/agentflow)](https://www.npmjs.com/package/@anhonestboy/agentflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-231%20passed-brightgreen)](.)

---

Write complex multi-agent workflows in clean, readable `.aflow` files. Each workflow becomes a **tool in Claude Code** via MCP — zero integration code. Assign different AI models to different agents, run iterative loops, and let agents collaborate with structured output.

```aflow
workflow code_quality
  description: "Iterative code review with writer, tester, and critic"
  version: "1.0.0"

  agents:
    agent writer     → model: "local-fast"
    agent tester     → model: "openrouter-smart"
    agent critic     → model: "claude-sonnet"

  loop quality_gate
    phases: [write, test, review]
    repeat_while: review.verdict == "needs_work"
    max_iterations: 5

  done when: review.confidence >= 0.85
```

## Why AgentFlow?

| | Traditional (LangGraph, CrewAI) | AgentFlow DSL |
|---|---|---|
| **Define workflows** | Python code (~40 lines boilerplate) | `.aflow` file (~20 lines) |
| **Multi-model** | Manual provider switching | Per-agent model aliases |
| **MCP integration** | Write MCP server code | Automatic — each workflow = MCP tool |
| **Git-friendly** | Code + config scattered | Single `.aflow` file |
| **Reviewable** | Need Python knowledge | Readable by anyone |
| **Safety** | Manual guardrails | `irreversible: true` approval gate |
| **Transparency** | Custom logging | Execution receipt + tool declaration |

Run workflows on your **Claude subscription credit** (`provider: agent-sdk`) instead of pay-as-you-go API billing, poll long runs over MCP without timeouts, and gate irreversible actions (money, deploys, deletions) behind explicit approval.

## Quick Start

### 1. Install

```bash
npm install -g @anhonestboy/agentflow
```

### 2. Configure

```bash
agentflow init
```

Interactive wizard: choose providers (Claude, OpenRouter, Ollama), configure model aliases, save API keys.

### 3. Write a workflow

Create `my-workflow.aflow`:

```aflow
workflow blog_post
  description: "Generate and refine a blog post"
  version: "1.0.0"

  agents:
    agent researcher
      mode: patient
      must_produce:
        - outline
        - key_points

    agent writer
      mode: focused
      must_produce:
        - draft
        - word_count: int

    agent editor
      mode: adversarial
      must_produce:
        - verdict
        - suggestions
        - confidence: float

  phases:
    phase research
      agent: researcher
      input: [trigger.topic]
      output: [outline, key_points]

    phase write
      agent: writer
      input: [research.outline, research.key_points]
      output: [draft, word_count]

    phase edit
      agent: editor
      input: [write.draft]
      output: [verdict, suggestions, confidence]

  loop revision_cycle
    phases: [write, edit]
    repeat_while: edit.verdict == "needs_work"
    max_iterations: 3
    on_each_iteration:
      send_to: writer
      payload: edit.suggestions

  done when: edit.confidence >= 0.8 and edit.verdict == "approved"
```

### 4. Run

```bash
agentflow check my-workflow.aflow     # Validate
agentflow run my-workflow.aflow --input 'topic="AI in photography"'
```

### 5. Add to Claude Code

```bash
agentflow mcp-config
```

Copy the JSON output to your Claude Code MCP settings. Your workflow is now a tool — call it directly from Claude Code.

## Supported Providers

| Provider | Status | Notes |
|---|---|---|
| **Claude** (Anthropic) | ✅ | Native SDK, multi-round tool use, API key (pay-as-you-go) |
| **Claude Agent SDK** | ✅ | Subscription auth — uses your plan's monthly Agent SDK credit |
| **OpenRouter** | ✅ | 315+ models, automatic provider routing |
| **DeepSeek** | ✅ | Native API (`deepseek-chat`, `deepseek-reasoner`), no OpenRouter key needed |
| **Ollama** | ✅ | Local execution, no API key needed |

Configure model aliases for cost optimization — use cheap models for drafting, frontier models for review:

```json
{
  "models": {
    "local-fast":       { "provider": "ollama",      "model": "qwen3:8b" },
    "openrouter-smart": { "provider": "openrouter",  "model": "google/gemini-2.5-flash" },
    "deepseek-chat":    { "provider": "deepseek",    "model": "deepseek-chat" },
    "claude-sonnet":    { "provider": "claude",      "model": "claude-sonnet-4-5" },
    "claude-plan":      { "provider": "agent-sdk",   "model": "claude-sonnet-4-5" }
  }
}
```

The `deepseek` provider talks to DeepSeek's native OpenAI-compatible API at `https://api.deepseek.com` and reads the key from `DEEPSEEK_API_KEY` — no OpenRouter account required. Example models: `deepseek-chat` (V3) and `deepseek-reasoner` (R1).

### Run on your Claude subscription (no API credits)

The `agent-sdk` provider routes agents through the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) using your Claude login instead of an API key. Usage draws from your plan's [monthly Agent SDK credit](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (Pro $20, Max 5x $100, Max 20x $200 — starting June 15, 2026), not from pay-as-you-go API billing.

Setup:

```bash
npm install @anthropic-ai/claude-agent-sdk   # optional dependency
claude login                                  # Claude Code must be logged in
```

Then point an agent (or alias) at the provider:

```aflow
agent writer
  model: "claude-plan"
```

Note: if `ANTHROPIC_API_KEY` is set, the Agent SDK would silently bill your API account instead — AgentFlow unsets it for `agent-sdk` agents so usage stays on the subscription credit.

## CLI Reference

```bash
agentflow init                     # Interactive setup wizard
agentflow check <file>             # Validate workflow + summary
agentflow run <file> --input '…'   # Execute with real LLMs
agentflow run <file> --mock        # Execute with mock agents (no API key needed)
agentflow run <file> --approve-irreversible   # Authorize irreversible phases
agentflow run <file> --output-dir <dir>       # Where phase outputs go (or $AGENTFLOW_OUTPUT_DIR)
agentflow run <file> --state-dir  <dir>       # Where <uuid>.state.json goes (or $AGENTFLOW_STATE_DIR)
agentflow compile <file>           # Compile to IR JSON
agentflow validate <file>          # Validate only (no summary)
agentflow mcp-config               # Print MCP server config for Claude Code
agentflow models                   # List configured models + connectivity
agentflow resume <file> --instance <uuid>  # Resume a paused/interrupted workflow
```

### Exit codes (`run` / `resume`)

`run` and `resume` return an honest exit code so scripts and orchestrators can branch on the outcome:

| Code | Meaning |
|---|---|
| `0` | Workflow **completed** |
| `1` | Workflow **failed** (or an unexpected terminal state) — a summary of `failed_steps` is printed |
| `2` | Workflow **paused** at an irreversibility gate or a `human_action_required` phase — the resume command is printed |

Every run also prints a stable, parseable cost line:

```
💰 total_cost_usd=0.012300 total_prompt_tokens=4500 total_completion_tokens=1200 cost_known=true
```

`cost_known=false` means no executor reported a dollar cost (e.g. local Ollama, or an unpriced model). Anthropic and DeepSeek costs come from a small static pricing map (override with `AGENTFLOW_PRICING_JSON='{"model":{"input":<usd/1M>,"output":<usd/1M>}}'`); OpenRouter reports its real cost via usage accounting. When cost is known, `max_cost` aborts the workflow once the accumulated cost exceeds the cap — including cost spent on schema-validation retries.

A budget-aborted run is reported as **failed (exit 1)**, not paused: the receipt records a `budget` failed step, and the saved state remains **resumable** (`agentflow resume` continues from the last checkpoint, e.g. after raising `max_cost`).

### State & output directories

By default `<uuid>.state.json` is written to the current directory and outputs to `./output/<workflow-id>`. When AgentFlow runs inside a target repo (e.g. via flow), set `--state-dir` / `$AGENTFLOW_STATE_DIR` and `--output-dir` / `$AGENTFLOW_OUTPUT_DIR` to keep the working tree clean. `resume` reads state from the same configured directory.

### Tools are `claude`-only

Only the `claude` provider actually executes agent `tools` (`file_write`, `file_read`, `shell_exec`, `test_runner`). Declaring tools on an `openrouter`/`deepseek`/`ollama`/`agent-sdk` agent — or naming a tool the registry doesn't implement — is a **validation error (S14)**: the model would otherwise hallucinate the tool results. Either move the agent to a `claude` model or drop the tools.

## Language Reference

### Agents

```
agent <id>
  model: "<alias>"         # Model alias from config (default: "auto")
  mode: <mode>             # focused | adversarial | reliable | precise | strict | patient | objective
  tools: [<name>, ...]     # Built-in tools: file_write, file_read, shell_exec, test_runner
  must_produce:
    - <name>               # Required output field (string)
    - <name>: float        # Typed output field
  constraint: "<rule>"     # Natural language constraint
```

### Phases

```
phase <id>
  agent: <agent_id>
  input: [<ref>, ...]          # trigger.field or phase_id.output
  output: [<name>, ...]
  inject_context: "<path>"     # Optional: inject file content into agent context
  timeout: 30min               # For human_action_required phases
```

### Loops

```
loop <id>
  phases: [<phase_id>, ...]
  repeat_while: <condition>    # review.verdict == "needs_work"
  max_iterations: <n>
  on_each_iteration:
    send_to: <agent_id>
    payload: <ref>             # Feedback to inject
  on_max_exceeded:
    escalate_to: <agent_id>
    message: "<...>"
```

### Conditions

```aflow
# Comparison
review.confidence >= 0.85

# Logical
review.verdict == "approved" and review.confidence >= 0.85
not (review.verdict == "needs_work")
```

## Architecture

```
.aflow file
    │
    ▼
 Tokenizer ──► Parser ──► Compiler (AST → IR)
                              │
                    ┌─────────▼──────────┐
                    │   Validator (S1-S14) │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │  WorkflowRunner     │
                    │  ┌───────────────┐  │
                    │  │ ExecutorResolver│  │
                    │  │ ┌─────────────┐│  │
                    │  │ │ Claude      ││  │
                    │  │ │ OpenRouter  ││  │
                    │  │ │ Ollama      ││  │
                    │  │ └─────────────┘│  │
                    │  └───────────────┘  │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │  MCP Server         │
                    │  (stdio JSON-RPC)   │
                    └─────────┬──────────┘
                              │
                     Claude Code / Cursor
```

## Examples

| File | Description |
|---|---|
| `examples/blog-post.aflow` | Researcher → writer → editor with revision loop |
| `examples/code-quality.aflow` | Writer → tester → critic with quality gate loop |
| `examples/code-quality-with-plan.aflow` | Extended with planning phase |
| `examples/custom-domain.aflow` | 7-phase domain provisioning workflow |

## Development

```bash
git clone https://github.com/anhonestboy/agentflow.git
cd agentflow
npm install
npm run build
npm test          # 231 tests, 24 suites
npm run dev -- check examples/code-quality.aflow
```

## Roadmap

- **v1.1** — VS Code extension (syntax highlighting, LSP)
- **v1.2** — Parallel phase execution
- **v1.3** — Workflow registry & sharing
- **v2.0** — Web visualizer, CI/CD integration

## License

MIT — see [LICENSE](LICENSE) for details.
