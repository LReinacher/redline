import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangedFile, FileStatus } from './diff';
import { TreeNode, buildTree, filesIn, movedFrom } from './fileTree';
import { ReviewSession } from './session';

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
export class FilesView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<TreeNode>;
  private reviewed = new Set<string>();
  private roots: TreeNode[] = [];
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
          for (const file of filesIn(node)) {
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
        if (e.affectsConfiguration('redline.viewAsTree')) this.refresh();
      }),
    );
  }

  private stateKey(session: ReviewSession): string {
    return `reviewed:${session.id}`;
  }

  refresh(): void {
    const session = this.getSession();
    this.reviewed = new Set(session ? this.state.get<string[]>(this.stateKey(session), []) : []);
    const files = session?.files ?? [];
    this.roots = viewAsTree() ? buildTree(files) : files.map((file) => ({ kind: 'file', file }));
    this.updateHeader();
    this.changed.fire();
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
    this.view.message = this.caveat(session);
  }

  private caveat(session: ReviewSession): string | undefined {
    if (session.files.length === 0) return 'No changes.';
    if (session.target.kind === 'staged') {
      return 'Editors show the working tree, so unstaged edits to these files also appear.';
    }
    return undefined;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.getSession()) return [];
    if (!node) return this.roots;
    return node.kind === 'folder' ? node.children : [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const session = this.getSession()!;
    const files = filesIn(node);
    const item =
      node.kind === 'folder'
        ? this.folderItem(session, node.path, node.label)
        : this.fileItem(session, node.file, !viewAsTree());
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
    const item = new vscode.TreeItem(path.posix.basename(file.path));
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
    this.changed.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}
