import * as vscode from 'vscode';
import { Decorator } from './decorator';
import { ChangedFile, Hunk } from './diff';
import { TreeNode } from './fileTree';
import { FilesView } from './filesView';
import { git, revParse, run } from './git';
import { BASE_SCHEME, BaseContentProvider, ReviewSession, ReviewTarget } from './session';

let session: ReviewSession | undefined;
let sessionSubscription: vscode.Disposable | undefined;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext) {
  const decorator = new Decorator(() => {
    if (context.globalState.get('hideInsetHint')) return;
    void vscode.window
      .showInformationMessage(
        'Redline shows removed lines as comment blocks. For Cursor-style blocks between the lines, add "enable-proposed-api": ["local.redline"] to argv.json and restart.',
        'Open argv.json',
        "Don't Show Again",
      )
      .then((choice) => {
        if (choice === 'Open argv.json') void vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
        if (choice === "Don't Show Again") void context.globalState.update('hideInsetHint', true);
      });
  });
  const files = new FilesView(context.workspaceState, () => session);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'redline.files.focus';

  // Splitting or moving an editor can blank its removed-line blocks; check them once things settle.
  let probeTimer: NodeJS.Timeout | undefined;
  const scheduleProbe = () => {
    if (!session) return;
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => decorator.probeInsets(), 400);
  };

  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (!session) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      session?.refresh().catch((e) => console.warn('[redline] refresh failed:', message(e)));
    }, 400);
  };

  function updateStatus() {
    if (!session) {
      status.hide();
      return;
    }
    const count = session.files.length;
    status.text = `$(diff) ${session.target.label} · ${count} ${count === 1 ? 'file' : 'files'}`;
    status.tooltip = `Redline against ${session.baseSha.slice(0, 7)}. Click to show the changed files.`;
    status.show();
  }

  async function startSession(root: string, target: ReviewTarget) {
    const next = new ReviewSession(root, target);
    try {
      await next.refresh();
    } catch (e) {
      next.dispose();
      void vscode.window.showErrorMessage(`Redline: ${message(e)}`);
      return;
    }
    endSession();
    session = next;
    sessionSubscription = next.onDidChange(() => {
      files.refresh();
      decorator.refreshVisible();
      updateStatus();
    });
    decorator.setSession(next);
    files.refresh();
    updateStatus();
    await vscode.commands.executeCommand('setContext', 'redline.active', true);
    if (next.files.length === 0) {
      void vscode.window.showInformationMessage(`Redline: no changes in ${target.label.toLowerCase()}.`);
    } else {
      // Show the file list, then give focus back to the editor the review was started from.
      const hadEditor = !!vscode.window.activeTextEditor;
      await vscode.commands.executeCommand('redline.files.focus');
      if (hadEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  function endSession() {
    sessionSubscription?.dispose();
    session?.dispose();
    session = undefined;
    decorator.setSession(undefined);
    files.refresh();
    updateStatus();
    void vscode.commands.executeCommand('setContext', 'redline.active', false);
    void vscode.commands.executeCommand('setContext', 'redline.fileHasChanges', false);
  }

  async function pickRepoRoot(): Promise<string | undefined> {
    const active = vscode.window.activeTextEditor?.document.uri;
    let folder = active && vscode.workspace.getWorkspaceFolder(active);
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folder) folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
    if (!folder) {
      if (folders.length === 0) void vscode.window.showErrorMessage('Redline: open a folder first.');
      return undefined;
    }
    try {
      return (await git(folder.uri.fsPath, 'rev-parse', '--show-toplevel')).trim();
    } catch {
      void vscode.window.showErrorMessage(`Redline: ${folder.name} is not a git repository.`);
      return undefined;
    }
  }

  async function reviewUncommitted() {
    const root = await pickRepoRoot();
    if (root) await startSession(root, { kind: 'uncommitted', label: 'Uncommitted changes' });
  }

  async function reviewStaged() {
    const root = await pickRepoRoot();
    if (root) await startSession(root, { kind: 'staged', label: 'Staged changes' });
  }

  async function reviewBranch(ref?: string) {
    const root = await pickRepoRoot();
    if (!root) return;
    if (!ref) {
      const out = await git(
        root,
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)%00%(refname)',
        'refs/heads',
        'refs/remotes',
      );
      const refs = out
        .split('\n')
        .filter((line) => line && !line.endsWith('/HEAD'))
        .map((line) => line.split('\0')[0]);
      const preferred = ['origin/main', 'origin/master', 'main', 'master'];
      const rank = (ref: string) => (preferred.includes(ref) ? preferred.indexOf(ref) : preferred.length);
      refs.sort((a, b) => rank(a) - rank(b));
      ref = await vscode.window.showQuickPick(refs, { placeHolder: 'Show changes on this branch since it split from...' });
    }
    if (!ref) return;
    let base: string;
    try {
      base = (await git(root, 'merge-base', 'HEAD', ref)).trim();
    } catch (e) {
      void vscode.window.showErrorMessage(`Redline: no common ancestor with ${ref}. ${message(e)}`);
      return;
    }
    await startSession(root, { kind: 'branch', label: `Changes vs ${ref}`, base });
  }

  async function reviewPullRequest(number?: number) {
    const root = await pickRepoRoot();
    if (!root) return;
    try {
      if (number === undefined) {
        const prs: { number: number; title: string; headRefName: string; author: { login: string } }[] = JSON.parse(
          await run('gh', ['pr', 'list', '--json', 'number,title,headRefName,author', '--limit', '50'], root),
        );
        const picked = await vscode.window.showQuickPick(
          prs.map((pr) => ({
            label: `#${pr.number} ${pr.title}`,
            description: `${pr.headRefName} · ${pr.author.login}`,
            number: pr.number,
          })),
          { placeHolder: prs.length ? 'Pull request to review' : 'No open pull requests', matchOnDescription: true },
        );
        number = picked?.number;
      }
      if (number === undefined) return;

      const pr: { baseRefName: string; headRefOid: string } = JSON.parse(
        await run('gh', ['pr', 'view', String(number), '--json', 'baseRefName,headRefOid'], root),
      );
      if ((await revParse(root, 'HEAD')) !== pr.headRefOid) {
        const choice = await vscode.window.showWarningMessage(
          `PR #${number} is not checked out.`,
          {
            modal: true,
            detail:
              'Go to definition and IntelliSense need the PR code on disk. "Check Out" runs `gh pr checkout`, which switches your branch.',
          },
          'Check Out',
          'Use Current Checkout',
        );
        if (!choice) return;
        if (choice === 'Check Out') {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Checking out PR #${number}...` },
            () => run('gh', ['pr', 'checkout', String(number)], root),
          );
        }
      }

      let fetched = true;
      await git(root, 'fetch', 'origin', pr.baseRefName).catch(() => (fetched = false));
      let base: string | undefined;
      for (const candidate of [fetched && 'FETCH_HEAD', `origin/${pr.baseRefName}`, pr.baseRefName]) {
        if (!candidate) continue;
        base = await git(root, 'merge-base', 'HEAD', candidate).then((s) => s.trim(), () => undefined);
        if (base) break;
      }
      if (!base) throw new Error(`could not find the merge base with ${pr.baseRefName}.`);
      await startSession(root, { kind: 'pr', label: `PR #${number}`, base });
    } catch (e) {
      void vscode.window.showErrorMessage(`Redline: ${message(e)}`);
    }
  }

  async function openFile(file: ChangedFile) {
    if (!session) return;
    const uri = file.status === 'D' ? session.baseUriFor(file) : session.uriFor(file);
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  function reveal(editor: vscode.TextEditor, line: number) {
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(Math.max(0, line - 1), 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Jump to the next or previous change. Past the last change of a file, continue in the next file. */
  async function goToChange(direction: 1 | -1) {
    if (!session) return;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const hunks = await decorator.hunksFor(editor.document);
      const line = editor.selection.active.line;
      const target =
        direction > 0 ? hunks.find((h) => h.start > line) : [...hunks].reverse().find((h) => h.start < line);
      if (target) return reveal(editor, target.start);
    }

    const list = session.files;
    const rel = editor && session.relPath(editor.document.uri);
    const current = rel ? list.findIndex((f) => f.path === rel) : -1;
    for (let step = 1; step <= list.length; step++) {
      const index =
        current === -1
          ? direction > 0
            ? step - 1
            : list.length - step
          : (((current + direction * step) % list.length) + list.length) % list.length;
      const file = list[index];
      if (file.status === 'D') {
        await openFile(file);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(session.uriFor(file));
      const hunks = await decorator.hunksFor(doc);
      if (hunks.length === 0) continue;
      const opened = await vscode.window.showTextDocument(doc, { preview: true });
      return reveal(opened, (direction > 0 ? hunks[0] : hunks[hunks.length - 1]).start);
    }
    void vscode.window.showInformationMessage('Redline: no more changes.');
  }

  async function revertChange(uri?: vscode.Uri, index?: number, version?: number) {
    const doc = uri
      ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
      : vscode.window.activeTextEditor?.document;
    if (!doc) return;
    const hunks = await decorator.hunksFor(doc);
    let hunk: Hunk | undefined;
    if (index !== undefined) {
      if (version !== doc.version) return;
      hunk = hunks[index];
    } else {
      const line = vscode.window.activeTextEditor?.selection.active.line ?? -1;
      hunk = hunks.find((h) =>
        h.added > 0 ? line >= h.start && line < h.start + h.added : line === h.start || line === h.start - 1,
      );
    }
    if (!hunk) {
      void vscode.window.showInformationMessage('Redline: no change at the cursor.');
      return;
    }
    await decorator.revert(doc, hunk);
  }

  async function openNativeDiff(arg?: ChangedFile | TreeNode | vscode.Uri) {
    if (!session) return;
    // The view's inline action passes a tree node, the editor title button passes the file's URI.
    let file: ChangedFile | undefined;
    let uri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) uri = arg;
    else if (arg && 'kind' in arg) file = arg.kind === 'file' ? arg.file : undefined;
    else file = arg;
    if (!file) {
      // Keep the editor's own URI so the diff shows the same document, even through a symlink.
      uri ??= vscode.window.activeTextEditor?.document.uri;
      const rel = uri && session.relPath(uri);
      if (!rel) return;
      file = session.file(rel) ?? { status: 'M', path: rel };
    }
    const title = `${file.path} (${session.target.label})`;
    await vscode.commands.executeCommand('vscode.diff', session.baseUriFor(file), uri ?? session.uriFor(file), title);
  }

  async function watchGit() {
    try {
      const extension = vscode.extensions.getExtension<any>('vscode.git');
      const api = (await extension?.activate())?.getAPI(1);
      if (!api) return;
      const watch = (repo: any) => context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
      api.repositories.forEach(watch);
      context.subscriptions.push(api.onDidOpenRepository(watch));
    } catch (e) {
      console.warn('[redline] git extension unavailable, refreshing on save only:', message(e));
    }
  }
  void watchGit();

  const command = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    decorator,
    files,
    status,
    { dispose: endSession },
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider(() => session?.repoRoot)),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, decorator),
    command('redline.start', async () => {
      const modes = [
        { label: 'Uncommitted changes', run: reviewUncommitted },
        { label: 'Staged changes', run: reviewStaged },
        { label: 'Changes against a branch...', run: () => reviewBranch() },
        { label: 'A GitHub pull request...', run: () => reviewPullRequest() },
      ];
      const picked = await vscode.window.showQuickPick(modes, { placeHolder: 'What do you want to review?' });
      await picked?.run();
    }),
    command('redline.reviewUncommitted', reviewUncommitted),
    command('redline.reviewStaged', reviewStaged),
    command('redline.reviewBranch', (ref?: string) => reviewBranch(typeof ref === 'string' ? ref : undefined)),
    command('redline.reviewPullRequest', (n?: number) => reviewPullRequest(typeof n === 'number' ? n : undefined)),
    command('redline.end', endSession),
    command('redline.refresh', () => session?.refresh()),
    command('redline.nextChange', () => goToChange(1)),
    command('redline.previousChange', () => goToChange(-1)),
    command('redline.revertChange', revertChange),
    command('redline.openFile', openFile),
    command('redline.openNativeDiff', openNativeDiff),
    command('redline.viewAsTree', () =>
      vscode.workspace.getConfiguration('redline').update('viewAsTree', true, vscode.ConfigurationTarget.Global),
    ),
    command('redline.viewAsList', () =>
      vscode.workspace.getConfiguration('redline').update('viewAsTree', false, vscode.ConfigurationTarget.Global),
    ),
    command('redline.toggleDeletedLines', async () => {
      const config = vscode.workspace.getConfiguration('redline');
      const next = config.get('deletedLines') === 'inline' ? 'hover' : 'inline';
      await config.update('deletedLines', next, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!session || e.contentChanges.length === 0) return;
      decorator.trackEdit(e);
      decorator.schedule(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => decorator.forget(doc)),
    vscode.window.onDidChangeVisibleTextEditors(() => session && decorator.refreshVisible()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const hunks = editor && decorator.state(editor.document)?.hunks;
      void vscode.commands.executeCommand('setContext', 'redline.fileHasChanges', !!hunks?.length);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('redline') && session) decorator.refreshVisible();
    }),
    vscode.window.onDidChangeVisibleTextEditors(scheduleProbe),
    vscode.window.onDidChangeActiveTextEditor(scheduleProbe),
    vscode.window.onDidChangeTextEditorViewColumn(scheduleProbe),
    vscode.window.onDidChangeTextEditorVisibleRanges(scheduleProbe),
    vscode.window.onDidChangeWindowState(scheduleProbe),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleProbe),
    vscode.window.tabGroups.onDidChangeTabs(scheduleProbe),
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.workspace.onDidCreateFiles(scheduleRefresh),
    vscode.workspace.onDidDeleteFiles(scheduleRefresh),
    vscode.workspace.onDidRenameFiles(scheduleRefresh),
  );

  // Used by the integration tests.
  return {
    session: () => session,
    hunks: (doc: vscode.TextDocument) => decorator.hunksFor(doc),
    threadCount: (doc: vscode.TextDocument) => decorator.threadCount(doc),
    insetCount: (doc: vscode.TextDocument) => decorator.insetCount(doc),
    probeInsets: () => decorator.probeInsets(),
  };
}

export function deactivate() {}
