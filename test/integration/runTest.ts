import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(import.meta.dirname, '../..');

function createRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  const write = (file: string, lines: string[]) => fs.writeFileSync(path.join(repo, file), lines.join('\n') + '\n');

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('a.ts', ['export function a() {', '  const x = 1;', '  return foo(bar);', '}', '', 'const one = 1;', 'const two = 2;', 'export const three = 3;']);
  write('b.ts', ['export const b = 1;']);
  write('.gitignore', ['ignored.ts']);
  fs.mkdirSync(path.join(repo, 'old'));
  write('old/d.ts', ['export const d1 = 1;', 'export const d2 = 2;', 'export const d3 = 3;', 'export const d4 = 4;']);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  write('b.ts', ['export const b = 2;', 'export const c = 3;']);
  git('commit', '-q', '-am', 'change b');

  // Uncommitted work: modify a line, delete two lines, add an untracked and an ignored file, and
  // move a file with plain mv (not git mv) and edit it.
  write('a.ts', ['export function a() {', '  const x = 1;', '  return foo(baz);', '}', '', 'export const three = 3;']);
  write('c.ts', ['export const c = 1;']);
  write('ignored.ts', ['export const ignored = 1;']);
  fs.mkdirSync(path.join(repo, 'new'));
  fs.renameSync(path.join(repo, 'old/d.ts'), path.join(repo, 'new/d.ts'));
  write('new/d.ts', ['export const d1 = 1;', 'export const d2 = 2;', 'export const d3 = 3;', 'export const d4 = 40;']);
  return repo;
}

// Once with the proposed API (removed lines in insets), once without (comment fallback).
for (const insets of [true, false]) {
  const repo = createRepo();
  // The default user data dir inside .vscode-test makes the IPC socket path too long on macOS.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-user-'));
  console.log(insets ? 'With --enable-proposed-api:' : 'Without the proposed API:');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'out/integration/suite.js'),
      launchArgs: [
        repo,
        '--disable-extensions',
        '--disable-workspace-trust',
        ...(insets ? ['--enable-proposed-api', 'local.redline'] : []),
        `--user-data-dir=${userData}`,
      ],
      extensionTestsEnv: { REDLINE_REPO: repo, REDLINE_INSETS: String(insets) },
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
