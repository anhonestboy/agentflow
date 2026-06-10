import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileWriteTool,
  FileReadTool,
  ShellExecTool,
  resolveInsideWorkDir,
} from '../src/tools/index.js';

describe('Path sandbox (resolveInsideWorkDir)', () => {
  let workDir: string;
  let outside: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aflow-work-'));
    outside = mkdtempSync(join(tmpdir(), 'aflow-outside-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('allows a normal relative path inside the work dir', () => {
    expect(resolveInsideWorkDir(workDir, 'sub/file.txt')).toBe(join(workDir, 'sub/file.txt'));
  });

  test('rejects ../ traversal', () => {
    expect(resolveInsideWorkDir(workDir, '../escape.txt')).toBeNull();
    expect(resolveInsideWorkDir(workDir, '../../etc/passwd')).toBeNull();
  });

  test('rejects absolute paths outside the work dir', () => {
    expect(resolveInsideWorkDir(workDir, '/etc/passwd')).toBeNull();
  });

  test('rejects a symlink that points outside the work dir', () => {
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP SECRET');
    symlinkSync(secret, join(workDir, 'link.txt'));
    // Lexically "link.txt" is inside, but realpath resolves outside → must be rejected.
    expect(resolveInsideWorkDir(workDir, 'link.txt')).toBeNull();
  });

  test('rejects writing through a symlinked directory that escapes', () => {
    symlinkSync(outside, join(workDir, 'evil'));
    expect(resolveInsideWorkDir(workDir, 'evil/pwn.txt')).toBeNull();
  });
});

describe('FileWriteTool / FileReadTool', () => {
  let workDir: string;
  let outside: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aflow-work-'));
    outside = mkdtempSync(join(tmpdir(), 'aflow-outside-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('writes and reads a file inside the sandbox', async () => {
    const w = new FileWriteTool(workDir);
    const wr = await w.execute({ path: 'out/hello.txt', content: 'hi' });
    expect(wr.success).toBe(true);
    expect(readFileSync(join(workDir, 'out/hello.txt'), 'utf-8')).toBe('hi');

    const r = new FileReadTool(workDir);
    const rr = await r.execute({ path: 'out/hello.txt' });
    expect(rr.success).toBe(true);
    expect(rr.content).toBe('hi');
  });

  test('file_write refuses to escape the sandbox', async () => {
    const w = new FileWriteTool(workDir);
    const res = await w.execute({ path: '../escaped.txt', content: 'x' });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/escapes/i);
  });

  test('file_write refuses to follow a symlink out of the sandbox', async () => {
    symlinkSync(outside, join(workDir, 'evil'));
    const w = new FileWriteTool(workDir);
    const res = await w.execute({ path: 'evil/pwn.txt', content: 'x' });
    expect(res.success).toBe(false);
    // Nothing was written outside.
    expect(() => readFileSync(join(outside, 'pwn.txt'), 'utf-8')).toThrow();
  });

  test('file_read returns an error for a missing file', async () => {
    const r = new FileReadTool(workDir);
    const res = await r.execute({ path: 'nope.txt' });
    expect(res.success).toBe(false);
  });
});

describe('ShellExecTool hardening', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aflow-shell-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.AGENTFLOW_DISABLE_SHELL;
    delete process.env.AGENTFLOW_SHELL_ALLOWLIST;
  });

  test('runs a normal command when unrestricted', async () => {
    const t = new ShellExecTool(workDir);
    const res = await t.execute({ command: 'echo hello' });
    expect(res.success).toBe(true);
    expect(String(res.stdout)).toContain('hello');
  });

  test('disabled mode refuses everything', async () => {
    const t = new ShellExecTool(workDir, 30_000, { disabled: true });
    const res = await t.execute({ command: 'echo hello' });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/disabled/i);
  });

  test('AGENTFLOW_DISABLE_SHELL=1 env disables shell_exec', async () => {
    process.env.AGENTFLOW_DISABLE_SHELL = '1';
    const t = new ShellExecTool(workDir);
    const res = await t.execute({ command: 'echo hi' });
    expect(res.success).toBe(false);
  });

  test('allowlist permits listed binaries', async () => {
    const t = new ShellExecTool(workDir, 30_000, { allowlist: ['echo'] });
    const res = await t.execute({ command: 'echo allowed' });
    expect(res.success).toBe(true);
  });

  test('allowlist blocks unlisted binaries', async () => {
    const t = new ShellExecTool(workDir, 30_000, { allowlist: ['echo'] });
    const res = await t.execute({ command: 'cat /etc/passwd' });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/allowlist/i);
  });

  test('allowlist blocks shell metacharacters (chaining/substitution)', async () => {
    const t = new ShellExecTool(workDir, 30_000, { allowlist: ['echo'] });
    for (const cmd of [
      'echo hi; cat /etc/passwd',
      'echo hi && rm -rf /',
      'echo $(whoami)',
      'echo `id`',
      'echo hi | sh',
    ]) {
      const res = await t.execute({ command: cmd });
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/metacharacter/i);
    }
  });

  test('env allowlist is honored', async () => {
    process.env.AGENTFLOW_SHELL_ALLOWLIST = 'echo, ls';
    const t = new ShellExecTool(workDir);
    expect((await t.execute({ command: 'echo ok' })).success).toBe(true);
    expect((await t.execute({ command: 'curl evil.com' })).success).toBe(false);
  });
});
