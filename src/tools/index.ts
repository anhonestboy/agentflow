import { writeFileSync, readFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { logger } from '../logger.js';

// ─── Path Security ─────────────────────────────────────────────────

/**
 * Resolves `relPath` against `workDir` and verifies — both lexically and
 * via realpath (symlink-aware) — that the target stays inside `workDir`.
 * Returns the absolute path, or null if the path escapes the sandbox.
 */
export function resolveInsideWorkDir(workDir: string, relPath: string): string | null {
  const absPath = resolve(workDir, relPath);

  // 1. Lexical check (catches ../ traversal)
  const rel = relative(workDir, absPath);
  if (rel.startsWith('..') || resolve(workDir, rel) !== absPath) return null;

  // 2. Symlink-aware check: realpath of the deepest existing ancestor
  //    (the file itself may not exist yet for writes)
  try {
    const realWorkDir = realpathSync(workDir);
    let probe = absPath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = realpathSync(probe);
    const realRel = relative(realWorkDir, realProbe);
    if (realRel.startsWith('..') || realRel.startsWith('/')) return null;
  } catch {
    return null;
  }

  return absPath;
}

// ─── Tool Interface ────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// ─── Test Runner Tool ──────────────────────────────────────────────

export class TestRunnerTool implements Tool {
  name = 'test_runner';
  description =
    'Executes TypeScript code in a temporary file and returns stdout, stderr, and exit code.';
  input_schema = {
    type: 'object' as const,
    properties: {
      code: { type: 'string', description: 'TypeScript code to execute' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default: 10000)' },
    },
    required: ['code'],
  };

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { writeFileSync: wfs, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');

    const code = String(input['code'] ?? '');
    const timeout = Number(input['timeout_ms'] ?? 10000);
    const tmpFile = `${tmpdir()}/agentflow-test-${randomUUID()}.ts`;

    try {
      wfs(tmpFile, code, 'utf-8');
      process.stderr.write(`  🧪 [test_runner] running...\n`);
      const stdout = execFileSync('npx', ['tsx', tmpFile], {
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { success: true, stdout: stdout.trim(), stderr: '', exit_code: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
      return {
        success: false,
        stdout: e.stdout?.trim() ?? '',
        stderr: (e.stderr?.trim() ?? e.message ?? 'Unknown error').slice(0, 1000),
        exit_code: e.status ?? 1,
      };
    } finally {
      try {
        const { unlinkSync: rm } = await import('node:fs');
        rm(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── Tool Registry ─────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getForAgent(toolNames: string[]): Tool[] {
    return toolNames.map((n) => this.tools.get(n)).filter((t): t is Tool => t !== undefined);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

// ─── Built-in Tools ────────────────────────────────────────────────

export class FileWriteTool implements Tool {
  name = 'file_write';
  description = 'Write content to a file. Creates parent directories if needed.';
  input_schema = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path (relative to working directory)' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  };

  constructor(private workDir: string) {}

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = input.path as string;
    const absPath = resolveInsideWorkDir(this.workDir, relPath);
    if (!absPath) {
      return { success: false, error: 'Path escapes working directory' };
    }

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, input.content as string);
    logger.info(`[file_write] ${relPath}`);
    return { success: true, path: relPath };
  }
}

export class FileReadTool implements Tool {
  name = 'file_read';
  description = 'Read content from a file.';
  input_schema = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path (relative to working directory)' },
    },
    required: ['path'],
  };

  constructor(private workDir: string) {}

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = input.path as string;
    const absPath = resolveInsideWorkDir(this.workDir, relPath);
    if (!absPath) {
      return { success: false, error: 'Path escapes working directory' };
    }

    try {
      const content = readFileSync(absPath, 'utf-8');
      return { success: true, content };
    } catch {
      return { success: false, error: `File not found: ${relPath}` };
    }
  }
}

export class ShellExecTool implements Tool {
  name = 'shell_exec';
  description = 'Execute a shell command and return stdout/stderr.';
  input_schema = {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  };

  private allowlist: string[] | null;
  private disabled: boolean;

  constructor(
    private workDir: string,
    private timeoutMs = 30_000,
    options?: { allowlist?: string[]; disabled?: boolean },
  ) {
    // Env-level controls (CLI/MCP users can set these without touching code):
    //   AGENTFLOW_DISABLE_SHELL=1          → shell_exec always refuses
    //   AGENTFLOW_SHELL_ALLOWLIST=git,npm  → only listed commands, no shell metacharacters
    this.disabled = options?.disabled ?? process.env.AGENTFLOW_DISABLE_SHELL === '1';
    const envList = process.env.AGENTFLOW_SHELL_ALLOWLIST?.trim();
    this.allowlist =
      options?.allowlist ??
      (envList
        ? envList
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
        : null);
  }

  /** Shell metacharacters that enable chaining/substitution — blocked in allowlist mode. */
  private static readonly UNSAFE_CHARS = /[;&|`$<>(){}\n\r\\]/;

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command = String(input.command ?? '');

    if (this.disabled) {
      logger.warn(`[shell_exec] BLOCKED (AGENTFLOW_DISABLE_SHELL=1): ${command}`);
      return { success: false, error: 'shell_exec is disabled (AGENTFLOW_DISABLE_SHELL=1)' };
    }

    if (this.allowlist) {
      if (ShellExecTool.UNSAFE_CHARS.test(command)) {
        logger.warn(`[shell_exec] BLOCKED (metacharacters in allowlist mode): ${command}`);
        return {
          success: false,
          error:
            'Command contains shell metacharacters (;|&`$<>(){} etc.) — not allowed when AGENTFLOW_SHELL_ALLOWLIST is set',
        };
      }
      const binary = command.trim().split(/\s+/)[0] ?? '';
      if (!this.allowlist.includes(binary)) {
        logger.warn(`[shell_exec] BLOCKED (not in allowlist): ${command}`);
        return {
          success: false,
          error: `Command "${binary}" is not in the allowlist (${this.allowlist.join(', ')})`,
        };
      }
    }

    logger.info(`[shell_exec] ${command}`);
    try {
      const stdout = execSync(command, {
        cwd: this.workDir,
        timeout: this.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, stdout: stdout.trim(), exit_code: 0 };
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      return {
        success: false,
        stdout: (execErr.stdout ?? '').trim(),
        stderr: (execErr.stderr ?? '').trim(),
        exit_code: execErr.status ?? 1,
      };
    }
  }
}

// ─── Factory ───────────────────────────────────────────────────────

export function createBuiltinRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new FileWriteTool(workDir));
  registry.register(new FileReadTool(workDir));
  registry.register(new ShellExecTool(workDir));
  registry.register(new TestRunnerTool());
  return registry;
}
