import * as vscode from 'vscode';
import { Hunk, computeHunks, removedBlockIds, wordChanges } from './diff';
import { RemovedLineInsets } from './insets';
import { ReviewSession } from './session';

interface DocState {
  version: number;
  hunks: Hunk[];
}

const MAX_SHOWN_REMOVED_LINES = 200;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function config() {
  const c = vscode.workspace.getConfiguration('redline');
  return {
    deletedLines: c.get<'inline' | 'hover'>('deletedLines', 'inline'),
    codeLens: c.get<boolean>('codeLens', true),
    wordHighlights: c.get<boolean>('wordHighlights', true),
  };
}

/** Editors embedded in another editor, such as the two sides of a diff editor, have no column. */
function isEmbedded(editor: vscode.TextEditor): boolean {
  return editor.viewColumn === undefined;
}

function removedCode(hunk: Hunk): string {
  const shown = hunk.removed.slice(0, MAX_SHOWN_REMOVED_LINES).map((line) => '- ' + line);
  const hidden = hunk.removed.length - shown.length;
  if (hidden > 0) shown.push(`  ... ${plural(hidden, 'more line')}`);
  return shown.join('\n');
}

/**
 * Renders the diff of every visible document against the session base, directly in the normal
 * editor. Added lines get a green background. Removed lines are shown in a block above the change
 * or on hover. The block is a webview inset when the proposed API is enabled, and a comment thread
 * otherwise (the only stable API that can insert space between editor lines).
 */
export class Decorator implements vscode.Disposable, vscode.CodeLensProvider {
  private session: ReviewSession | undefined;
  private readonly states = new Map<string, DocState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly threads = new Map<string, Map<string, vscode.CommentThread>>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;

  private readonly comments = vscode.comments.createCommentController('redline.removed', 'Removed lines');
  private readonly insets = new RemovedLineInsets(
    (doc, id) => void this.revertBlock(doc, id),
    (doc) => this.schedule(doc, 0),
  );
  private warnedNoInsets = false;

  constructor(private readonly onInsetsUnavailable: () => void) {}

  private readonly addedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly addedWord = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  });
  private readonly removedAbove = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removedBelow = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth: '0 0 2px 0',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removedRuler = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  setSession(session: ReviewSession | undefined): void {
    this.session = session;
    for (const key of [...this.states.keys(), ...this.threads.keys()]) this.clearKey(key);
    for (const editor of vscode.window.visibleTextEditors) this.clearEditor(editor);
    this.insets.clear();
    this.lensesChanged.fire();
    if (session) this.refreshVisible();
  }

  refreshVisible(): void {
    const docs = new Set(vscode.window.visibleTextEditors.map((e) => e.document));
    for (const doc of docs) void this.update(doc);
  }

  /** Recompute a document's diff after a short delay, so typing doesn't diff on every keystroke. */
  schedule(doc: vscode.TextDocument, delay = 60): void {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.update(doc);
      }, delay),
    );
  }

  /** Current hunks of a document, recomputed if the document changed since the last render. */
  async hunksFor(doc: vscode.TextDocument): Promise<Hunk[]> {
    const state = this.states.get(doc.uri.toString());
    if (state && state.version === doc.version) return state.hunks;
    await this.update(doc);
    return this.states.get(doc.uri.toString())?.hunks ?? [];
  }

  state(doc: vscode.TextDocument): DocState | undefined {
    return this.states.get(doc.uri.toString());
  }

  threadCount(doc: vscode.TextDocument): number {
    return this.threads.get(doc.uri.toString())?.size ?? 0;
  }

  insetCount(doc: vscode.TextDocument): number {
    return this.insets.count(doc);
  }

  trackEdit(e: vscode.TextDocumentChangeEvent): void {
    this.insets.trackEdit(e);
  }

  /** Replaces removed-line blocks that went blank, see `RemovedLineInsets.probe`. */
  probeInsets(): void {
    this.insets.probe(vscode.window.visibleTextEditors);
  }

  async update(doc: vscode.TextDocument): Promise<void> {
    const session = this.session;
    const key = doc.uri.toString();
    const rel = session?.relPath(doc.uri);
    const base = session && rel ? await session.baseFor(rel) : undefined;
    if (session !== this.session) return;
    if (!session || base === undefined || doc.isClosed) {
      this.clearKey(key);
      for (const editor of this.editorsFor(doc)) this.clearEditor(editor);
      return;
    }

    const version = doc.version;
    const text = doc.getText();
    const hunks = computeHunks(base, text);
    this.states.set(key, { version, hunks });

    const settings = config();
    const lines = settings.wordHighlights ? text.split(/\r?\n/) : [];
    const added: vscode.DecorationOptions[] = [];
    const words: vscode.DecorationOptions[] = [];
    const above: vscode.DecorationOptions[] = [];
    const below: vscode.DecorationOptions[] = [];
    const lastLine = doc.lineCount - 1;

    for (const hunk of hunks) {
      const hoverMessage =
        settings.deletedLines === 'hover' && hunk.removed.length > 0 ? this.hover(hunk, session) : undefined;
      if (hunk.added > 0) {
        added.push({ range: new vscode.Range(hunk.start, 0, hunk.start + hunk.added - 1, 0), hoverMessage });
        if (settings.wordHighlights) {
          for (const r of wordChanges(hunk, lines)) {
            words.push({ range: new vscode.Range(r.line, r.startChar, r.line, r.endChar) });
          }
        }
      } else if (hunk.start <= lastLine) {
        above.push({ range: new vscode.Range(hunk.start, 0, hunk.start, 0), hoverMessage });
      } else {
        below.push({ range: new vscode.Range(lastLine, 0, lastLine, 0), hoverMessage });
      }
    }

    const hover = settings.deletedLines === 'hover';
    let insetsShown = !hover;
    for (const editor of this.editorsFor(doc)) {
      // Diff editors draw their own diff.
      if (isEmbedded(editor)) {
        this.clearEditor(editor);
        continue;
      }
      editor.setDecorations(this.addedLine, added);
      editor.setDecorations(this.addedWord, words);
      editor.setDecorations(this.removedAbove, hover ? above : []);
      editor.setDecorations(this.removedBelow, hover ? below : []);
      editor.setDecorations(this.removedRuler, hover ? [] : [...above, ...below]);
      if (hover) this.insets.clear(editor);
      else insetsShown = this.insets.sync(editor, hunks) && insetsShown;
    }
    const useThreads = !hover && !insetsShown;
    if (useThreads && !this.warnedNoInsets) {
      this.warnedNoInsets = true;
      this.onInsetsUnavailable();
    }
    this.syncThreads(doc, hunks, useThreads);
    this.lensesChanged.fire();
    if (doc === vscode.window.activeTextEditor?.document) {
      void vscode.commands.executeCommand('setContext', 'redline.fileHasChanges', hunks.length > 0);
    }
  }

  private hover(hunk: Hunk, session: ReviewSession): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${plural(hunk.removed.length, 'line')} removed** since \`${session.baseSha.slice(0, 7)}\``);
    md.appendCodeblock(removedCode(hunk), 'diff');
    return md;
  }

  /**
   * Keeps one comment thread per hunk with removed lines. Threads are matched by their removed
   * text, so typing elsewhere moves existing threads instead of recreating them (which would
   * flicker and lose their collapsed state).
   */
  private syncThreads(doc: vscode.TextDocument, hunks: Hunk[], enabled: boolean): void {
    const key = doc.uri.toString();
    const existing = this.threads.get(key) ?? new Map<string, vscode.CommentThread>();
    const next = new Map<string, vscode.CommentThread>();
    const ids = removedBlockIds(hunks);

    for (const [i, hunk] of (enabled ? hunks : []).entries()) {
      const id = ids[i];
      if (id === undefined) continue;

      // The thread's block renders below its line, so anchor on the line before the change.
      const anchor = Math.min(Math.max(0, hunk.start - 1), doc.lineCount - 1);
      const range = new vscode.Range(anchor, 0, anchor, 0);
      let thread = existing.get(id);
      if (thread) {
        existing.delete(id);
        if (!thread.range.isEqual(range)) thread.range = range;
      } else {
        thread = this.createThread(doc.uri, range, hunk);
      }
      next.set(id, thread);
    }

    for (const stale of existing.values()) stale.dispose();
    if (next.size > 0) this.threads.set(key, next);
    else this.threads.delete(key);
  }

  private createThread(uri: vscode.Uri, range: vscode.Range, hunk: Hunk): vscode.CommentThread {
    const body = new vscode.MarkdownString();
    body.appendCodeblock(removedCode(hunk), 'diff');
    const thread = this.comments.createCommentThread(uri, range, [
      {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: `${plural(hunk.removed.length, 'line')} removed` },
      },
    ]);
    thread.canReply = false;
    thread.contextValue = 'redline.removed';
    thread.label = 'Removed';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    // Resolved threads don't open the Comments panel when comments.openView is firstFileUnresolved.
    thread.state = vscode.CommentThreadState.Resolved;
    return thread;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const state = this.states.get(doc.uri.toString());
    const settings = config();
    if (!settings.codeLens || !state || state.version !== doc.version) return [];
    // Inset blocks carry their own Revert button; a lens would sit between the red and green lines.
    const blocksHaveButtons = settings.deletedLines === 'inline' && this.insets.isAvailable;
    return state.hunks.flatMap((hunk, index) => {
      if (blocksHaveButtons && hunk.removed.length > 0) return [];
      const line = Math.min(hunk.start, doc.lineCount - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const summary = [hunk.added && `+${hunk.added}`, hunk.removed.length && `−${hunk.removed.length}`]
        .filter(Boolean)
        .join(' ');
      return [
        new vscode.CodeLens(range, { title: summary, command: '' }),
        new vscode.CodeLens(range, {
          title: 'Revert',
          tooltip: 'Restore the base version of this change',
          command: 'redline.revertChange',
          arguments: [doc.uri, index, state.version],
        }),
      ];
    });
  }

  private async revertBlock(doc: vscode.TextDocument, id: string): Promise<void> {
    const hunks = await this.hunksFor(doc);
    const index = removedBlockIds(hunks).indexOf(id);
    if (index !== -1) await this.revert(doc, hunks[index]);
  }

  /** Replace a hunk's added lines with its removed lines. */
  async revert(doc: vscode.TextDocument, hunk: Hunk): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    const restored = hunk.removed.map((line) => line + '\n').join('');
    const end = hunk.start + hunk.added;
    const last = doc.lineAt(doc.lineCount - 1);
    if (end < doc.lineCount) {
      edit.replace(doc.uri, new vscode.Range(hunk.start, 0, end, 0), restored);
    } else if (hunk.added > 0) {
      // The change runs to the end of a file without a final newline.
      edit.replace(doc.uri, new vscode.Range(hunk.start, 0, last.lineNumber, last.text.length), restored.slice(0, -1));
    } else {
      edit.insert(doc.uri, last.range.end, '\n' + restored.slice(0, -1));
    }
    return vscode.workspace.applyEdit(edit);
  }

  forget(doc: vscode.TextDocument): void {
    this.clearKey(doc.uri.toString());
  }

  private editorsFor(doc: vscode.TextDocument): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document === doc);
  }

  private clearKey(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.states.delete(key);
    for (const thread of this.threads.get(key)?.values() ?? []) thread.dispose();
    this.threads.delete(key);
  }

  private clearEditor(editor: vscode.TextEditor): void {
    for (const type of [this.addedLine, this.addedWord, this.removedAbove, this.removedBelow, this.removedRuler]) {
      editor.setDecorations(type, []);
    }
    this.insets.clear(editor);
  }

  dispose(): void {
    for (const key of [...this.states.keys(), ...this.threads.keys()]) this.clearKey(key);
    this.comments.dispose();
    this.insets.dispose();
    this.removedRuler.dispose();
    this.lensesChanged.dispose();
    this.addedLine.dispose();
    this.addedWord.dispose();
    this.removedAbove.dispose();
    this.removedBelow.dispose();
  }
}
