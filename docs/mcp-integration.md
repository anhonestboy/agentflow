# MCP Integration

AgentFlow workflows are exposed as MCP (Model Context Protocol) tools, making them callable directly from Claude Code, Cursor, and any MCP-compatible client.

## How it works

1. AgentFlow scans a directory for `.aflow` files
2. Each workflow becomes an MCP tool named after its `workflow` ID
3. The tool's description is the workflow's `description` field
4. Calling the tool executes the workflow against configured LLM providers
5. Results are returned as structured JSON

## Setup

### 1. Generate MCP config

```bash
agentflow mcp-config
```

Output:

```json
{
  "mcpServers": {
    "agentflow": {
      "command": "npx",
      "args": ["-y", "--package=@anhonestboy/agentflow", "agentflow-mcp"],
      "env": {
        "AGENTFLOW_WORKFLOWS_DIR": "/path/to/your/workflows",
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "OPENROUTER_API_KEY": "sk-or-...",
        "DEEPSEEK_API_KEY": "sk-..."
      }
    }
  }
}
```

### 2. Add to Claude Code

#### Project-scoped (recommended)

Run from your project root:

```bash
claude mcp add agentflow \
  -e AGENTFLOW_WORKFLOWS_DIR="$PWD" \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -- npx -y --package=@anhonestboy/agentflow agentflow-mcp
```

This saves to `.claude/settings.json` — workflows are available only in this project.

#### Global

```bash
claude mcp add agentflow -s user \
  -e AGENTFLOW_WORKFLOWS_DIR="/Users/you/workflows" \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -- npx -y --package=@anhonestboy/agentflow agentflow-mcp
```

Workflows available in every project.

### 3. Use in Claude Code

Once configured, your workflows appear as tools:

```
> Run code_quality on src/auth.ts

Claude calls agentflow's code_quality tool → writer → tester → critic → results
```

## Long-running workflows (async execution)

Multi-agent workflows can take minutes — longer than most MCP clients are willing to wait. The server handles this automatically:

- **Fast workflows** (finished within `AGENTFLOW_SYNC_TIMEOUT_MS`, default 45s) return their full result directly, as before.
- **Long workflows** return immediately with `{"state": "running", "instance_id": "..."}`. Poll with the built-in `agentflow_status` tool:

```json
{ "name": "agentflow_status", "arguments": { "instance_id": "94f623fb-..." } }
```

The status response includes live per-phase progress (`phase_states`), loop iterations, the execution receipt, and — once the workflow finishes — the full `phase_outputs`.

Notes:

- The instance registry is in-memory: if the server restarts, poll handles are lost (state files on disk can still be resumed via `agentflow resume`).
- Set `AGENTFLOW_SYNC_TIMEOUT_MS=0` to force every call to return an async handle.

## Irreversible phases (approval gate)

Workflows with phases marked `irreversible: true` declare them in the tool description and expose an optional `approve_irreversible` boolean argument. Without it, the workflow pauses at the gate and the response includes a hint:

```json
{ "state": "paused", "instance_id": "...", "hint": "Workflow paused at irreversible phase \"deploy\"..." }
```

Review the state (via `agentflow_status`), then resume with the `agentflow_resume` tool:

```json
{ "name": "agentflow_resume", "arguments": { "instance_id": "...", "approve_irreversible": true } }
```

## Testing without API keys

Set `AGENTFLOW_MOCK=1` to run every workflow with mock executors — useful for validating workflow structure and MCP wiring before spending tokens. `AGENTFLOW_MOCK_DELAY_MS=<ms>` simulates slow agents to exercise the async path.

## Workflows Directory

The MCP server watches `AGENTFLOW_WORKFLOWS_DIR` and exposes every `.aflow` file as a tool:

```
workflows/
├── code-review.aflow      → tool: code_review
├── blog-post.aflow        → tool: blog_post
├── deploy-check.aflow     → tool: deploy_check
└── domain-provision.aflow → tool: domain_provision
```

## Configuration

The MCP server reads `agentflow.config.json` from `AGENTFLOW_WORKFLOWS_DIR` or uses built-in defaults. Model aliases and provider credentials are resolved per-agent at execution time.

## Required Environment Variables

| Variable | Required for | Description |
|---|---|---|
| `AGENTFLOW_WORKFLOWS_DIR` | Always | Directory containing `.aflow` files |
| `ANTHROPIC_API_KEY` | Claude executor | Your Anthropic API key |
| `OPENROUTER_API_KEY` | OpenRouter executor | Your OpenRouter API key |
| `DEEPSEEK_API_KEY` | DeepSeek executor | Your DeepSeek API key (https://platform.deepseek.com) |
| `OLLAMA_BASE_URL` | Ollama executor | Ollama server URL (default: `http://localhost:11434`) |
