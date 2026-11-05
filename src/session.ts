import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangedFile, parseNameStatus } from './diff';
import { EMPTY_TREE, diffWithUntracked, git, revParse, showFile } from './git';

export type ReviewKind = 'uncommitted' | 'staged' | 'branch' | 'pr';

export interface ReviewTarget {
  kind: ReviewKind;
  label: string;
  /** Fixed base commit for branch and PR reviews. Uncommitted and staged reviews use HEAD. */
  base?: string;
}

export const BASE_SCHEME = 'redline-base';

/**
 * The set of changed files for one review and access to their base content. The editor always
 * shows the working tree file; the base is what it gets compared against.
 */
export class ReviewSession implements vscode.Disposable {
  files: ChangedFile[] = [];
  baseSha = '';
  readonly id: string;

  private refreshVersion = 0;
  private forceRefresh = false;
  private fingerprint: string | undefined;
  private byPath = new Map<string, ChangedFile>();
  private baseContents = new Map<string, Promise<string | undefined>>();
  private relPaths = new Map<string, string | undefined>();
  private readonly realRoot: string;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    readonly repoRoot: string,
    readonly target: ReviewTarget,
  ) {
    this.realRoot = fs.realpathSync.native(repoRoot);
    this.id = [repoRoot, target.kind, target.base ?? ''].join(':');
  }

  /** Whether files outside the change list should also be diffed when they differ from the base. */
  get tracksWorkingTree(): boolean {
    return this.target.kind !== 'staged';
  }

  async refresh(force = false): Promise<void> {
    this.forceRefresh ||= force;
    const version = ++this.refreshVersion;
    const base = this.target.base ?? (await revParse(this.repoRoot, 'HEAD')) ?? EMPTY_TREE;
    const files = await this.listFiles(base);
    files.sort((a, b) => a.path.localeCompare(b.path));
    // Git emits status events for index refreshes and unrelated repository activity too.
    // Compare file metadata as well as names so edits to an already-modified file still refresh.
    const metadata = await Promise.all(files.map(async (file) => {
      try {
        const stat = await fs.promises.stat(path.join(this.repoRoot, file.path), { bigint: true });
        return [stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
      } catch { return null; }
    }));
    if (version !== this.refreshVersion) return;
    const fingerprint = JSON.stringify([base, files, metadata]);
    const forced = this.forceRefresh;
    this.forceRefresh = false;
    if (!forced && fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    if (base !== this.baseSha) {
      this.baseContents.clear();
      this.baseSha = base;
    }
    this.files = files;
    this.byPath = new Map(files.map((f) => [f.path, f]));
    this.changed.fire();
  }

  private async listFiles(base: string): Promise<ChangedFile[]> {
    const root = this.repoRoot;
    switch (this.target.kind) {
      case 'staged':
        return parseNameStatus(await git(root, 'diff', '--cached', '--name-status', '-z', '-M', base));
      default: {
        const untracked = (await git(root, 'ls-files', '--others', '--exclude-standard', '-z'))
          .split('\0')
          .filter(Boolean);
        if (untracked.length === 0) return parseNameStatus(await git(root, 'diff', '--name-status', '-z', '-M', base));
        try {
          return parseNameStatus(await diffWithUntracked(root, base, untracked));
        } catch (e) {
          // Older git without --pathspec-from-file: list untracked files as added, without renames.
          console.warn('[redline] rename detection for untracked files failed:', e);
          const tracked = parseNameStatus(await git(root, 'diff', '--name-status', '-z', '-M', base));
          const seen = new Set(tracked.map((f) => f.path));
          const added = untracked.filter((p) => !seen.has(p)).map((p): ChangedFile => ({ status: 'A', path: p }));
          return [...tracked, ...added];
        }
      }
    }
  }

  file(rel: string): ChangedFile | undefined {
    return this.byPath.get(rel);
  }

  /** Repo-relative path of a document, or undefined if it lives outside the repository. */
  relPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const key = uri.fsPath;
    if (!this.relPaths.has(key)) {
      let real = key;
      try {
        real = fs.realpathSync.native(key);
      } catch {
        // New files that aren't on disk yet keep their path as is.
      }
      const rel = path.relative(this.realRoot, real);
      const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      this.relPaths.set(key, inside ? rel.split(path.sep).join('/') : undefined);
    }
    return this.relPaths.get(key);
  }

  /**
   * Text to compare a file against, or undefined if the file should not be decorated. Files in the
   * change list always get a base (empty for new files). Other files only get one in reviews that
   * track the working tree, and only if they exist in the base, so that ignored files such as
   * node_modules don't light up green when you jump to a definition.
   */
  async baseFor(rel: string): Promise<string | undefined> {
    const file = this.byPath.get(rel);
    if (file) {
      if (file.status === 'A') return '';
      return (await this.content(file.oldPath ?? rel)) ?? '';
    }
    if (!this.tracksWorkingTree) return undefined;
    return this.content(rel);
  }

  private content(rel: string): Promise<string | undefined> {
    let content = this.baseContents.get(rel);
    if (!content) {
      content = showFile(this.repoRoot, this.baseSha, rel);
      this.baseContents.set(rel, content);
    }
    return content;
  }

  uriFor(file: ChangedFile): vscode.Uri {
    return vscode.Uri.file(path.join(this.repoRoot, file.path));
  }

  baseUriFor(file: ChangedFile): vscode.Uri {
    const rel = file.oldPath ?? file.path;
    return vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + rel, query: this.baseSha });
  }

  dispose(): void {
    this.refreshVersion++;
    this.changed.dispose();
  }
}

/** Serves base revisions as read-only documents, for deleted files and the side-by-side diff. */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly getRoot: () => string | undefined) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const root = this.getRoot();
    if (!root) return '';
    return (await showFile(root, uri.query, uri.path.slice(1))) ?? '';
  }
}
