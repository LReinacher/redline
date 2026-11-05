import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';

const repo = process.env.REDLINE_REPO!;
const insets = process.env.REDLINE_INSETS === 'true';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function step(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`  ✔ ${name}`);
}

export async function run() {
  const api = await vscode.extensions.getExtension('local.redline')!.activate();
  // Removed-line blocks are insets when the proposed API is enabled and comment threads otherwise.
  const blocks = (doc: vscode.TextDocument): number => {
    const [used, unused] = insets
      ? [api.insetCount(doc), api.threadCount(doc)]
      : [api.threadCount(doc), api.insetCount(doc)];
    assert.equal(unused, 0);
    return used;
  };
  const open = async (file: string) => {
    const doc = await vscode.workspace.openTextDocument(path.join(repo, file));
    return vscode.window.showTextDocument(doc);
  };

  await step('uncommitted review lists modified, untracked and moved files, not ignored ones', async () => {
    await vscode.commands.executeCommand('redline.reviewUncommitted');
    const files = api.session().files.map((f: any) => `${f.status} ${f.oldPath ?? ''} ${f.path}`.replace('  ', ' '));
    assert.deepEqual(files, ['M a.ts', 'A c.ts', 'R old/d.ts new/d.ts']);
  });

  await step('review guide discovers changed roots and unchanged callers through providers', async () => {
    const fixtureRoot = realpathSync(repo);
    const uri = (file: string) => vscode.Uri.file(path.join(fixtureRoot, file));
    const range = (start: number, end: number) => new vscode.Range(start, 0, end, 20);
    const a = new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'a', '', uri('a.ts'), range(0, 3), range(0, 0));
    const c = new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'c', '', uri('c.ts'), range(0, 0), range(0, 0));
    const b = new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'b', '', uri('b.ts'), range(0, 0), range(0, 0));
    const selector = { scheme: 'file', pattern: new vscode.RelativePattern(fixtureRoot, '{a,c}.ts') };
    let failIncoming = false;
    let callRequests = 0;
    let callGate: Promise<void> | undefined;
    const providers = [
      vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols(doc) {
          const item = doc.uri.fsPath.endsWith('/a.ts') ? a : c;
          return [new vscode.DocumentSymbol(item.name, '', item.kind, item.range, item.selectionRange)];
        },
      }),
      vscode.languages.registerCallHierarchyProvider(selector, {
        prepareCallHierarchy(doc) { return doc.uri.fsPath.endsWith('/a.ts') ? a : c; },
        async provideCallHierarchyIncomingCalls(item) {
          callRequests++;
          await callGate;
          if (failIncoming) throw new Error('Synthetic provider failure');
          return item.name === 'a' ? [] : [
            { from: a, fromRanges: [range(2, 2)] },
            { from: b, fromRanges: [range(0, 0)] },
          ];
        },
        provideCallHierarchyOutgoingCalls() { return []; },
      }),
    ];
    try {
      await vscode.commands.executeCommand('redline.refresh');
      const view = api.filesView;
      const deadline = Date.now() + 15000;
      while (!view.view.message?.includes('Ready to review.') && Date.now() < deadline) await wait(50);
      assert.ok(view.view.message?.includes('Ready to review.'), 'analysis completes');
      const roots = view.getChildren();
      assert.ok(!roots.some((n: any) => n.group === 'entry'), 'graph roots do not promote implementation files');
      const implementation = roots.find((n: any) => n.group === 'implementation');
      assert.ok(implementation);
      const aFile = view.getChildren(implementation).find((n: any) => n.file?.path === 'a.ts');
      assert.ok(aFile);
      const aSymbol = view.getChildren(aFile)[0];
      assert.equal(aSymbol.symbol.changeRoot, true);
      assert.equal(view.getTreeItem(aSymbol).command.command, 'vscode.open');
      assert.equal(view.getTreeItem(aSymbol).checkboxState, undefined);
      assert.ok(view.getTreeItem(aSymbol).description.includes('Change root'));
      assert.ok(!view.getTreeItem(aSymbol).description.includes('Entry point'));
      const cFile = view.getChildren(implementation).find((n: any) => n.file?.path === 'c.ts');
      const cSymbol = view.getChildren(cFile)[0];
      assert.equal(cSymbol.symbol.changeRoot, false);
      const callers = view.getChildren(cSymbol);
      assert.equal(callers.length, 1);
      assert.equal(callers[0].call.from.name, 'b');
      assert.equal(view.provideCodeLenses(await vscode.workspace.openTextDocument(uri('c.ts'))).length, 1);

      const requestsBefore = callRequests;
      let redraws = 0;
      const subscription = view.onDidChangeTreeData(() => { redraws++; });
      try {
        // Repeated Git status notifications must not restart discovery for an identical review.
        await api.session().refresh();
        await api.session().refresh();
        assert.equal(callRequests, requestsBefore);
        assert.equal(redraws, 0);
        assert.equal(view.getChildren(), roots);

        // Hold discovery halfway through a real refresh: no partial tree is published.
        let release!: () => void;
        callGate = new Promise<void>((resolve) => { release = resolve; });
        try {
          await vscode.commands.executeCommand('redline.refresh');
          const startedDeadline = Date.now() + 10000;
          while (callRequests === requestsBefore && Date.now() < startedDeadline) await wait(50);
          assert.ok(callRequests > requestsBefore);
          assert.ok(view.view.message?.includes('Tracing callers:'), `message: ${view.view.message}, requests: ${callRequests - requestsBefore}`);
          assert.equal(view.getChildren(), roots);
          assert.equal(redraws, 0);
        } finally {
          release();
          callGate = undefined;
        }
        const settledDeadline = Date.now() + 15000;
        while (!view.view.message?.includes('Ready to review.') && Date.now() < settledDeadline) await wait(50);
        assert.ok(view.view.message?.includes('Ready to review.'));
        assert.equal(redraws, 1, 'completed analysis publishes one tree snapshot');
      } finally {
        subscription.dispose();
      }

      // Application boundaries remain explicitly configurable, independently of graph hints.
      const config = vscode.workspace.getConfiguration('redline');
      const previousEntryPatterns = config.inspect<string[]>('reviewPatterns.entry')?.globalValue;
      try {
        await config.update('reviewPatterns.entry', ['**/a.ts'], vscode.ConfigurationTarget.Global);
        const entryGroup = view.getChildren().find((n: any) => n.group === 'entry');
        assert.ok(entryGroup);
        assert.ok(view.getChildren(entryGroup).some((n: any) => n.file?.path === 'a.ts'));
      } finally {
        await config.update('reviewPatterns.entry', previousEntryPatterns, vscode.ConfigurationTarget.Global);
      }

      // Folder nodes in different groups must have distinct IDs, even for the same directory.
      await vscode.workspace.getConfiguration('redline').update('viewAsTree', true, vscode.ConfigurationTarget.Global);
      const ids: string[] = [];
      const visit = (node: any) => {
        const id = view.getTreeItem(node).id;
        if (id) ids.push(id);
        for (const child of view.getChildren(node)) visit(child);
      };
      view.getChildren().forEach(visit);
      assert.equal(ids.length, new Set(ids).size);
      await vscode.workspace.getConfiguration('redline').update('viewAsTree', false, vscode.ConfigurationTarget.Global);

      // VS Code can turn a provider failure into an empty list; prior callers must still clear.
      failIncoming = true;
      await vscode.commands.executeCommand('redline.refresh');
      const retryDeadline = Date.now() + 15000;
      while (!view.view.message?.includes('Ready to review.') && Date.now() < retryDeadline) await wait(50);
      assert.ok(view.view.message?.includes('Ready to review.'));
      const afterFailure = view.getChildren().flatMap((g: any) =>
        view.getChildren(g).flatMap((f: any) => view.getChildren(f)));
      assert.ok(afterFailure.length > 0);
      assert.ok(afterFailure.every((n: any) => n.symbol.outside.length === 0));
      assert.equal(view.provideCodeLenses(await vscode.workspace.openTextDocument(uri('c.ts'))).length, 0);
    } finally {
      providers.forEach((provider) => provider.dispose());
    }
  });

  await step('an external edit to an already-listed file refreshes the review', async () => {
    const file = path.join(repo, 'c.ts');
    const original = readFileSync(file, 'utf8');
    const session = api.session();
    const paths = session.files.map((f: any) => f.path);
    let changes = 0;
    const subscription = session.onDidChange(() => { changes++; });
    try {
      writeFileSync(file, 'export const c = 200;\n');
      await session.refresh();
      const deadline = Date.now() + 10000;
      while (!changes && Date.now() < deadline) await wait(50);
      assert.ok(changes > 0, 'content changes refresh even if the changed-file list is identical');
      assert.deepEqual(session.files.map((f: any) => f.path), paths);
    } finally {
      subscription.dispose();
      writeFileSync(file, original);
      await session.refresh();
    }
  });

  await step('a moved file is diffed against its old path', async () => {
    assert.deepEqual(await api.hunks((await open('new/d.ts')).document), [
      { start: 3, added: 1, removed: ['export const d4 = 4;'] },
    ]);
  });

  const editor = await open('a.ts');
  const doc = editor.document;

  await step('hunks and removed-line blocks for a modified file', async () => {
    assert.deepEqual(await api.hunks(doc), [
      { start: 2, added: 1, removed: ['  return foo(bar);'] },
      { start: 5, added: 0, removed: ['const one = 1;', 'const two = 2;'] },
    ]);
    assert.equal(blocks(doc), 2);
  });

  await step('editing updates the diff live', async () => {
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// new line\n'));
    await wait(300);
    assert.deepEqual(await api.hunks(doc), [
      { start: 0, added: 1, removed: [] },
      { start: 3, added: 1, removed: ['  return foo(bar);'] },
      { start: 6, added: 0, removed: ['const one = 1;', 'const two = 2;'] },
    ]);
    assert.equal(blocks(doc), 2);
  });

  await step('next and previous change navigation', async () => {
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('redline.nextChange');
    assert.equal(editor.selection.active.line, 3);
    await vscode.commands.executeCommand('redline.nextChange');
    assert.equal(editor.selection.active.line, 6);
    await vscode.commands.executeCommand('redline.previousChange');
    assert.equal(editor.selection.active.line, 3);
  });

  await step('revert restores the base lines', async () => {
    await vscode.commands.executeCommand('redline.revertChange', doc.uri, 2, doc.version);
    await vscode.commands.executeCommand('redline.revertChange', doc.uri, 0, doc.version);
    assert.deepEqual(await api.hunks(doc), [{ start: 2, added: 1, removed: ['  return foo(bar);'] }]);
    assert.ok(doc.getText().includes('const one = 1;\nconst two = 2;\n'));
    assert.equal(blocks(doc), 1);
  });

  await step('the diff editor gets no extra blocks', async () => {
    await vscode.commands.executeCommand('redline.openNativeDiff', doc.uri);
    await wait(500);
    assert.ok(vscode.window.visibleTextEditors.some((e) => e.document === doc && e.viewColumn === undefined));
    assert.equal(blocks(doc), 0);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await wait(300);
    assert.equal(blocks(doc), 1);
  });

  await step('unchanged and ignored files get no decorations', async () => {
    assert.deepEqual(await api.hunks((await open('b.ts')).document), []);
    assert.deepEqual(await api.hunks((await open('ignored.ts')).document), []);
  });

  await step('untracked file is all added', async () => {
    assert.deepEqual(await api.hunks((await open('c.ts')).document), [{ start: 0, added: 1, removed: [] }]);
  });

  await step('branch review includes committed and uncommitted work', async () => {
    await vscode.commands.executeCommand('redline.reviewBranch', 'main');
    assert.deepEqual(api.session().files.map((f: any) => f.path), ['a.ts', 'b.ts', 'c.ts', 'new/d.ts']);
  });

  await step('hover mode removes the blocks', async () => {
    await open('a.ts');
    const config = vscode.workspace.getConfiguration('redline');
    await config.update('deletedLines', 'hover', vscode.ConfigurationTarget.Global);
    await wait(300);
    assert.equal(blocks(doc), 0);
    await config.update('deletedLines', 'inline', vscode.ConfigurationTarget.Global);
    await wait(300);
    assert.equal(blocks(doc), 1);
  });

  await step('ending the review clears everything', async () => {
    await vscode.commands.executeCommand('redline.end');
    assert.equal(api.session(), undefined);
    assert.equal(blocks(doc), 0);
    await wait(700);
    assert.deepEqual(api.filesView.getChildren(), []);
    assert.deepEqual(api.filesView.provideCodeLenses(doc), []);
  });
}
