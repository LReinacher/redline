import * as assert from 'node:assert/strict';
import * as path from 'node:path';
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
  });
}
