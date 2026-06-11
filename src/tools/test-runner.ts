import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class TestRunnerTool {
  name = 'test_runner';
  description = 'Executes TypeScript code and returns stdout, stderr, and exit code';
  input_schema = {
    type: 'object' as const,
    properties: {
      code: { type: 'string', description: 'TypeScript code to execute' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default: 10000)' },
    },
    required: ['code'],
  };

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const code = String(input['code'] ?? '');
    const timeout = Number(input['timeout_ms'] ?? 10000);

    const tmpFile = join(tmpdir(), `agentflow-test-${randomUUID()}.ts`);

    try {
      writeFileSync(tmpFile, code, 'utf-8');
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
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }
}
