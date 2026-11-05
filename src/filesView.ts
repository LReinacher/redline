import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangedFile, FileStatus } from './diff';
import { TreeNode, buildTree, filesIn, movedFrom } from './fileTree';
import { ReviewSession } from './session';
import { analyzeReview, ChangedSymbol } from './reviewAnalysis';
import { classifyFile, DEFAULT_PATTERNS, GROUP_LABELS, ReviewGroup } from './reviewGuide';

type GuideNode = TreeNode
  | { kind: 'group'; group: ReviewGroup; children: TreeNode[] }
  | { kind: 'symbol'; symbol: ChangedSymbol }
  | { kind: 'caller'; call: vscode.CallHierarchyIncomingCall };

function reviewFiles(node: GuideNode): ChangedFile[] {
  if (node.kind === 'symbol' || node.kind === 'caller') return [];
  return node.kind === 'group' ? node.children.flatMap(filesIn) : filesIn(node);
}

const STATUS_NAMES: Record<FileStatus, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged',
};

function viewAsTree(): boolean {
  return vscode.workspace.getConfiguration('redline').get<boolean>('viewAsTree', false);
}

/**
 * The session's changed files as a flat list or grouped by folder, with a checkbox to mark each
 * file as reviewed. Checking a folder marks every file in it.
 */
export class FilesView implements vscode.TreeDataProvider<GuideNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<GuideNode>;
  private reviewed = new Set<string>();
  private roots: GuideNode[] = [];
  private symbols = new Map<string, ChangedSymbol[]>();
  private scopes = new WeakMap<TreeNode, string>();
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private analyzing = false;
  private progressText: string | undefined;
  private displayedSession: ReviewSession | undefined;
  private finishProgress: (() => void) | undefined;
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly state: vscode.Memento,
    private readonly getSession: () => ReviewSession | undefined,
  ) {
    this.view = vscode.window.createTreeView('redline.files', {
      treeDataProvider: this,
      manageCheckboxStateManually: true,
      showCollapseAll: true,
    });
    this.subscriptions.push(
      this.view,
      this.view.onDidChangeCheckboxState((e) => {
        for (const [node, checked] of e.items) {
          for (const file of reviewFiles(node)) {
            if (checked === vscode.TreeItemCheckboxState.Checked) this.reviewed.add(file.path);
            else this.reviewed.delete(file.path);
          }
        }
        const session = this.getSession();
        if (session) void this.state.update(this.stateKey(session), [...this.reviewed]);
        this.updateHeader();
        // Folder checkboxes depend on their files, so redraw the whole tree.
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('redline.codeLens')) this.lensesChanged.fire();
        if (e.affectsConfiguration('redline.viewAsTree') || e.affectsConfiguration('redline.reviewPatterns')) {
          this.rebuild();
          this.changed.fire();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const session = this.getSession();
        if (!session || !e.contentChanges.length || !session.relPath(e.document.uri)) return;
        this.invalidate();
        this.analyzing = true;
        this.progressText = 'Waiting for edits to settle…';
        this.updateHeader();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 600);
      }),
    );
  }

  private stateKey(session: ReviewSession): string {
    return `reviewed:${session.id}`;
  }

  refresh(): void {
    const session = this.getSession();
    this.reviewed = new Set(session ? this.state.get<string[]>(this.stateKey(session), []) : []);
    clearTimeout(this.timer);
    this.invalidate();
    const generation = this.generation;
    this.analyzing = !!session?.files.length;
    this.progressText = this.analyzing ? 'Finding symbols…' : undefined;
    // Keep the previous snapshot while recomputing. Only a new review starts with path groups.
    if (session !== this.displayedSession || !this.analyzing) {
      this.displayedSession = session;
      this.symbols = new Map();
      this.rebuild();
      this.changed.fire();
    }
    if (session && this.analyzing) {
      const cancelled = () => generation !== this.generation || session !== this.getSession();
      void vscode.window.withProgress({ location: { viewId: 'redline.files' } }, async (progress) => {
        if (cancelled()) return;
        let percent = 0;
        const stopped = new Promise<void>((resolve) => { this.finishProgress = resolve; });
        const analysis = analyzeReview(session, cancelled, (state) => {
          if (cancelled()) return;
          const fraction = state.total ? state.completed / state.total : 1;
          const next = state.phase === 'symbols' ? fraction * 40 : 40 + fraction * 60;
          this.progressText = state.phase === 'symbols'
            ? `Finding symbols: ${state.completed}/${state.total} files`
            : `Tracing callers: ${state.completed}/${state.total} symbols`;
          progress.report({ message: this.progressText, increment: next - percent });
          percent = next;
          this.updateHeader();
        }).then((symbols) => {
          if (cancelled()) return;
          this.symbols = symbols;
          this.analyzing = false;
          this.progressText = undefined;
          this.rebuild();
          this.updateHeader();
          this.changed.fire();
          this.lensesChanged.fire();
        }).catch((error) => {
          if (cancelled()) return;
          this.analyzing = false;
          this.progressText = 'Analysis failed. Refresh to retry.';
          this.updateHeader();
          console.warn('[redline] review analysis failed:', error);
        });
        await Promise.race([analysis, stopped]);
        if (!cancelled()) this.finishProgress = undefined;
      });
    }
    this.updateHeader();
  }

  private invalidate(): void {
    this.generation++;
    this.finishProgress?.();
    this.finishProgress = undefined;
    // Hide stale CodeLens locations immediately, but leave the review tree in place.
    this.lensesChanged.fire();
  }

  private rebuild(): void {
    const session = this.getSession();
    const config = vscode.workspace.getConfiguration('redline', session && vscode.Uri.file(session.repoRoot));
    const patterns = {
      shape: config.get<string[]>('reviewPatterns.shape', DEFAULT_PATTERNS.shape),
      entry: config.get<string[]>('reviewPatterns.entry', DEFAULT_PATTERNS.entry),
      tests: config.get<string[]>('reviewPatterns.tests', DEFAULT_PATTERNS.tests),
    };
    this.roots = [];
    for (const group of Object.keys(GROUP_LABELS) as ReviewGroup[]) {
      const files = (session?.files ?? []).filter((file) =>
        classifyFile(file.path, patterns) === group);
      if (!files.length) continue;
      const children: TreeNode[] = viewAsTree() ? buildTree(files) : files.map((file) => ({ kind: 'file', file }));
      const scope = (node: TreeNode) => {
        this.scopes.set(node, group);
        if (node.kind === 'folder') node.children.forEach(scope);
      };
      children.forEach(scope);
      this.roots.push({ kind: 'group', group, children });
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.getSession();
    if (!session || this.analyzing || !vscode.workspace.getConfiguration('redline').get('codeLens', true)) return [];
    const rel = session.relPath(document.uri);
    return (rel ? this.symbols.get(rel) ?? [] : []).filter((s) => s.outside.length).map((s) =>
      new vscode.CodeLens(s.selectionRange, {
        command: 'editor.action.showReferences',
        title: `${s.outside.length} ${s.outside.length === 1 ? 'caller' : 'callers'} outside changed symbols`,
        arguments: [s.uri, s.selectionRange.start, s.outside.flatMap((c) =>
          c.fromRanges.map((range) => new vscode.Location(c.from.uri, range)))],
      }));
  }

  private updateHeader(): void {
    const session = this.getSession();
    if (!session) {
      this.view.description = undefined;
      this.view.message = undefined;
      return;
    }
    const total = session.files.length;
    const done = session.files.filter((f) => this.reviewed.has(f.path)).length;
    this.view.description = `${session.target.label} · ${done}/${total} reviewed`;
    this.view.message = [this.caveat(session), this.progressText ?? (session.files.length ? 'Ready to review.' : undefined)].filter(Boolean).join(' ') || undefined;
  }

  private caveat(session: ReviewSession): string | undefined {
    if (session.files.length === 0) return 'No changes.';
    if (session.target.kind === 'staged') {
      return 'Editors show the working tree, so unstaged edits to these files also appear.';
    }
    return undefined;
  }

  getChildren(node?: GuideNode): GuideNode[] {
    if (!this.getSession()) return [];
    if (!node) return this.roots;
    if (node.kind === 'group' || node.kind === 'folder') return node.children;
    if (node.kind === 'file') return (this.symbols.get(node.file.path) ?? []).map((symbol) => ({ kind: 'symbol', symbol }));
    if (node.kind === 'symbol') return node.symbol.outside.map((call) => ({ kind: 'caller', call }));
    return [];
  }

  getTreeItem(node: GuideNode): vscode.TreeItem {
    const session = this.getSession()!;
    if (node.kind === 'symbol') {
      const s = node.symbol;
      const item = new vscode.TreeItem(s.name, s.outside.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `symbol:${s.uri}:${s.selectionRange.start.line}:${s.selectionRange.start.character}:${s.name}`;
      item.contextValue = 'symbol';
      item.iconPath = new vscode.ThemeIcon(s.changeRoot ? 'call-outgoing' : 'symbol-method');
      item.description = [s.changeRoot ? 'Change root' : '', s.outside.length ? `${s.outside.length} outside callers` : ''].filter(Boolean).join(' · ');
      item.tooltip = `${s.name} (${s.selectionRange.start.line + 1})` + (s.changeRoot ? '\nNo incoming call from another changed symbol was reported. This may be an internal helper, not an application entry point; framework, interface, and dynamic calls may be missing.' : '');
      item.command = { command: 'vscode.open', title: 'Open Symbol', arguments: [s.uri, { selection: s.selectionRange }] };
      return item;
    }
    if (node.kind === 'caller') {
      const from = node.call.from;
      const item = new vscode.TreeItem(from.name);
      item.contextValue = 'caller';
      item.iconPath = new vscode.ThemeIcon('call-incoming');
      item.description = vscode.workspace.asRelativePath(from.uri);
      item.tooltip = `Caller outside the changed symbols: ${from.uri.fsPath}:${from.selectionRange.start.line + 1}`;
      item.command = { command: 'vscode.open', title: 'Open Caller', arguments: [from.uri, { selection: node.call.fromRanges[0] ?? from.selectionRange }] };
      return item;
    }
    const files = reviewFiles(node);
    const item = node.kind === 'group'
      ? new vscode.TreeItem(GROUP_LABELS[node.group], vscode.TreeItemCollapsibleState.Expanded)
      : node.kind === 'folder'
        ? this.folderItem(session, node.path, node.label)
        : this.fileItem(session, node.file, !viewAsTree());
    if (node.kind === 'group') {
      item.id = `group:${node.group}`;
      item.contextValue = 'group';
      item.description = String(files.length);
    } else if (node.kind === 'folder') item.id = `${this.scopes.get(node)}:${item.id}`;
    item.checkboxState = files.every((f) => this.reviewed.has(f.path))
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return item;
  }

  private folderItem(session: ReviewSession, folder: string, label: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `folder:${folder}`;
    item.resourceUri = vscode.Uri.file(path.join(session.repoRoot, folder));
    item.iconPath = vscode.ThemeIcon.Folder;
    item.contextValue = 'folder';
    return item;
  }

  private fileItem(session: ReviewSession, file: ChangedFile, showDir: boolean): vscode.TreeItem {
    const item = new vscode.TreeItem(path.posix.basename(file.path), this.symbols.get(file.path)?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(file.path);
    const from = movedFrom(file);
    item.id = `file:${file.path}`;
    item.resourceUri = session.uriFor(file);
    item.description = [showDir && dir !== '.' ? dir : '', file.status, from && `← ${from}`].filter(Boolean).join('  ');
    item.tooltip = file.oldPath
      ? `${STATUS_NAMES[file.status]}: ${file.oldPath} → ${file.path}`
      : `${STATUS_NAMES[file.status]}: ${file.path}`;
    item.contextValue = file.status === 'D' ? 'deleted' : 'file';
    item.command = { command: 'redline.openFile', title: 'Open File', arguments: [file] };
    return item;
  }

  dispose(): void {
    this.invalidate();
    clearTimeout(this.timer);
    this.lensesChanged.dispose();
    this.changed.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}
