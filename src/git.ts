import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Hash of the empty tree. Used as the base of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return run('git', args, cwd);
}

export async function revParse(cwd: string, rev: string): Promise<string | undefined> {
  try {
    return (await git(cwd, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`)).trim();
  } catch {
    return undefined;
  }
}

/** File content at a revision, or undefined if the file doesn't exist there or is binary. */
export async function showFile(cwd: string, rev: string, path: string): Promise<string | undefined> {
  try {
    const content = await git(cwd, 'cat-file', 'blob', `${rev}:${path}`);
    return content.includes('\0') ? undefined : content;
  } catch {
    return undefined;
  }
}

/**
 * `git diff --name-status -z -M <base>` as if the untracked files had been added, so that a file
 * moved with a plain `mv` shows up as a rename instead of a deletion and a new file. The untracked
 * files go into a copy of the index as intent-to-add entries; the real index is never touched.
 */
export async function diffWithUntracked(cwd: string, base: string, untracked: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-'));
  try {
    const index = path.join(dir, 'index');
    const realIndex = path.resolve(cwd, (await git(cwd, 'rev-parse', '--git-path', 'index')).trim());
    // A repository without an index has nothing staged, so an empty index is the same thing.
    await fs.copyFile(realIndex, index).catch(() => undefined);
    const list = path.join(dir, 'untracked');
    await fs.writeFile(list, untracked.join('\0'));
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' };
    await run('git', ['add', '--intent-to-add', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], cwd, env);
    return await run('git', ['diff', '--name-status', '-z', '-M', base], cwd, env);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
