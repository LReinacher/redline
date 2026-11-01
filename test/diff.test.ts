import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, parseNameStatus, shiftZoneLine, splitLines, wordChanges } from '../src/diff.ts';
import { buildTree, filesIn, movedFrom, type TreeNode } from '../src/fileTree.ts';

test('identical text has no hunks', () => {
  assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
});

test('line endings and missing final newline are ignored', () => {
  assert.deepEqual(computeHunks('a\r\nb\r\n', 'a\nb'), []);
});

test('pure addition', () => {
  assert.deepEqual(computeHunks('a\nc\n', 'a\nb\nc\n'), [{ start: 1, added: 1, removed: [] }]);
});

test('pure deletion records where the lines used to be', () => {
  assert.deepEqual(computeHunks('a\nb\nc\nd\n', 'a\nd\n'), [{ start: 1, added: 0, removed: ['b', 'c'] }]);
});

test('deletion at the end of the file', () => {
  assert.deepEqual(computeHunks('a\nb\n', 'a\n'), [{ start: 1, added: 0, removed: ['b'] }]);
});

test('modification groups removed and added lines into one hunk', () => {
  assert.deepEqual(computeHunks('a\nb\nc\n', 'a\nB\nc\n'), [{ start: 1, added: 1, removed: ['b'] }]);
});

test('several hunks keep correct line numbers', () => {
  const base = ['1', '2', '3', '4', '5', '6'].join('\n');
  const current = ['0', '1', '2', '4', '5', 'x', '6'].join('\n');
  assert.deepEqual(computeHunks(base, current), [
    { start: 0, added: 1, removed: [] },
    { start: 3, added: 0, removed: ['3'] },
    { start: 5, added: 1, removed: [] },
  ]);
});

test('new and emptied files', () => {
  assert.deepEqual(computeHunks('', 'a\nb\n'), [{ start: 0, added: 2, removed: [] }]);
  assert.deepEqual(computeHunks('a\nb\n', ''), [{ start: 0, added: 0, removed: ['a', 'b'] }]);
});

test('wordChanges highlights only the changed word', () => {
  const current = ['const x = 1;', 'return foo(bar);'];
  const [hunk] = computeHunks('const x = 1;\nreturn foo(baz);\n', current.join('\n'));
  assert.deepEqual(wordChanges(hunk, current), [{ line: 1, startChar: 11, endChar: 14 }]);
});

test('wordChanges skips rewrites with little in common', () => {
  const current = ['completely different text here'];
  const [hunk] = computeHunks('nothing alike\n', current.join('\n'));
  assert.deepEqual(wordChanges(hunk, current), []);
});

test('splitLines', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\n\nb\n'), ['a', '', 'b']);
});

test('parseNameStatus handles renames and plain entries', () => {
  const out = 'M\0src/a.ts\0R087\0old name.ts\0new name.ts\0D\0gone.ts\0';
  assert.deepEqual(parseNameStatus(out), [
    { status: 'M', path: 'src/a.ts' },
    { status: 'R', path: 'new name.ts', oldPath: 'old name.ts' },
    { status: 'D', path: 'gone.ts' },
  ]);
});

test('shiftZoneLine follows Monaco view zones through edits', () => {
  const zone = 5; // the zone sits below 0-based line 5
  // Typing or editing below the zone, or on its own line, leaves it alone.
  assert.equal(shiftZoneLine(zone, { start: 7, end: 7, insertedLines: 1 }), 5);
  assert.equal(shiftZoneLine(zone, { start: 5, end: 5, insertedLines: 1 }), 5);
  // Enter on an earlier line pushes it down.
  assert.equal(shiftZoneLine(zone, { start: 2, end: 2, insertedLines: 1 }), 6);
  // Deleting lines 3 and 4 (range from the end of line 2 to the end of line 4) pulls it up.
  assert.equal(shiftZoneLine(zone, { start: 2, end: 4, insertedLines: 0 }), 3);
  // A zone whose line was deleted lands where the deletion started.
  assert.equal(shiftZoneLine(4, { start: 2, end: 4, insertedLines: 0 }), 2);
  assert.equal(shiftZoneLine(3, { start: 2, end: 4, insertedLines: 2 }), 2);
  // The zone above the first line never moves.
  assert.equal(shiftZoneLine(-1, { start: 0, end: 0, insertedLines: 3 }), -1);
});

test('buildTree groups files by folder and compacts single-child folders', () => {
  const files = [
    { status: 'M' as const, path: 'README.md' },
    { status: 'M' as const, path: 'apps/api/src/b.ts' },
    { status: 'A' as const, path: 'apps/api/src/a.ts' },
    { status: 'R' as const, path: 'apps/api/test/c.ts', oldPath: 'apps/api/src/c.ts' },
    { status: 'D' as const, path: 'apps/web/x.ts' },
  ];
  const show = (nodes: TreeNode[]): unknown[] =>
    nodes.map((n) => (n.kind === 'folder' ? { [n.label]: show(n.children) } : n.file.path.split('/').pop()));
  const tree = buildTree(files);
  assert.deepEqual(show(tree), [
    { apps: [{ 'api': [{ src: ['a.ts', 'b.ts'] }, { test: ['c.ts'] }] }, { web: ['x.ts'] }] },
    'README.md',
  ]);
  const api = tree[0].kind === 'folder' ? tree[0].children[0] : undefined;
  assert.equal(api?.kind === 'folder' && api.path, 'apps/api');
  assert.equal(filesIn(tree[0]).length, 4);
});

test('buildTree joins a chain of single folders into one node', () => {
  const tree = buildTree([{ status: 'M', path: 'apps/api/src/modules/a.ts' }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].kind === 'folder' && tree[0].label, 'apps/api/src/modules');
  assert.equal(tree[0].kind === 'folder' && tree[0].path, 'apps/api/src/modules');
});

test('movedFrom shows the old name for renames and the old path for moves', () => {
  assert.equal(movedFrom({ status: 'M', path: 'src/a.ts' }), undefined);
  assert.equal(movedFrom({ status: 'R', path: 'src/b.ts', oldPath: 'src/a.ts' }), 'a.ts');
  assert.equal(movedFrom({ status: 'R', path: 'lib/a.ts', oldPath: 'src/a.ts' }), 'src/a.ts');
});
