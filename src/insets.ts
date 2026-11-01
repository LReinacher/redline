import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { Hunk, removedBlockIds, shiftZoneLine } from './diff';

const MAX_SHOWN_LINES = 200;
/** How long a block has to answer a ping before it counts as blank. */
const PING_TIMEOUT_MS = 1500;
/** Blocks that never reported in after this long are pinged too, in case they broke while loading. */
const LOAD_GRACE_MS = 5000;

interface Entry {
  inset: vscode.WebviewEditorInset;
  /** 0-based line the block sits below, or -1 for the top of the file. */
  line: number;
  created: number;
  /** Whether the webview script ran and answered at least once. */
  alive: boolean;
  ping?: NodeJS.Timeout;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(lines: string[], hidden: number, tabSize: number): string {
  const nonce = randomBytes(16).toString('base64');
  // The button follows the first line's text. The webview is as wide as the editor's longest line,
  // so a right-aligned button would end up off screen in narrow editors.
  const button = '<button title="Restore these lines">Revert</button>';
  const rows = lines.map((line, i) => `<div class="line">${escapeHtml(line) || ' '}${i === 0 ? button : ''}</div>`);
  if (hidden > 0) rows.push(`<div class="line more">... ${hidden} more removed lines</div>`);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html { background: var(--vscode-editor-background); }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  body {
    display: grid;
    grid-auto-rows: 1fr;
    background: var(--vscode-diffEditor-removedLineBackground);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    font-weight: var(--vscode-editor-font-weight);
    tab-size: ${tabSize};
  }
  .line { display: flex; align-items: center; white-space: pre; opacity: 0.8; }
  .more { font-style: italic; opacity: 0.6; }
  button {
    margin-left: 3ch;
    padding: 0 6px;
    border: none;
    border-radius: 3px;
    font: 11px/16px var(--vscode-font-family);
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    cursor: pointer;
    opacity: 0.7;
  }
  button:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
${rows.join('')}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelector('button').addEventListener('click', () => vscode.postMessage('revert'));
  window.addEventListener('message', (e) => e.data === 'ping' && vscode.postMessage('pong'));
  vscode.postMessage('pong');
</script>
</body>
</html>`;
}

/**
 * Shows removed lines in webview insets between editor lines, the same view zones Cursor and the
 * built-in diff editor use. Insets are a proposed API. In stable builds of VS Code and Cursor
 * they only work when the app is started with `--enable-proposed-api local.redline` or has
 * that key in argv.json, even in extension development mode.
 *
 * An inset's iframe reloads when its editor moves in the DOM, for example when the editor group is
 * split, and the workbench never refills a reloaded inset. `probe` finds those blank blocks: each
 * block answers pings, and one that stays silent is disposed and reported through `onBlank`.
 */
export class RemovedLineInsets implements vscode.Disposable {
  private available: boolean | undefined;
  private readonly editors = new Map<vscode.TextEditor, Map<string, Entry>>();

  /**
   * `onRevert` receives the block id from `removedBlockIds` when its Revert button is clicked.
   * `onBlank` is called after a blank block was disposed, so the caller can sync it again.
   */
  constructor(
    private readonly onRevert: (doc: vscode.TextDocument, id: string) => void,
    private readonly onBlank: (doc: vscode.TextDocument) => void,
  ) {}

  get isAvailable(): boolean {
    return this.available === true;
  }

  /** Shows one inset per hunk with removed lines. Returns false if the proposed API is disabled. */
  sync(editor: vscode.TextEditor, hunks: Hunk[]): boolean {
    if (this.available === false) return false;
    const existing = this.editors.get(editor) ?? new Map<string, Entry>();
    const next = new Map<string, Entry>();
    this.editors.set(editor, next);

    const ids = removedBlockIds(hunks);
    for (const [i, hunk] of hunks.entries()) {
      const id = ids[i];
      if (id === undefined) continue;
      // The inset renders below its line; -1 puts it above the first line.
      const line = hunk.start - 1;
      const entry = existing.get(id);
      if (entry && entry.line === line) {
        existing.delete(id);
        next.set(id, entry);
        continue;
      }
      const created = this.create(editor, id, line, hunk.removed);
      if (created === 'unavailable') {
        for (const e of [...existing.values(), ...next.values()]) e.inset.dispose();
        this.editors.delete(editor);
        return false;
      }
      if (created) next.set(id, created);
    }

    for (const stale of existing.values()) stale.inset.dispose();
    if (next.size === 0) this.editors.delete(editor);
    return true;
  }

  /** Pings the blocks in the given editors and replaces the ones that don't answer. */
  probe(editors: readonly vscode.TextEditor[]): void {
    const now = Date.now();
    for (const editor of editors) {
      for (const [id, entry] of this.editors.get(editor) ?? []) {
        if (entry.ping || (!entry.alive && now - entry.created < LOAD_GRACE_MS)) continue;
        entry.ping = setTimeout(() => {
          entry.ping = undefined;
          if (this.editors.get(editor)?.get(id) !== entry) return;
          entry.inset.dispose();
          this.onBlank(editor.document);
        }, PING_TIMEOUT_MS);
        void entry.inset.webview.postMessage('ping');
      }
    }
  }

  private create(
    editor: vscode.TextEditor,
    id: string,
    line: number,
    removed: string[],
  ): Entry | 'unavailable' | undefined {
    const shown = removed.slice(0, MAX_SHOWN_LINES);
    const hidden = removed.length - shown.length;
    let inset: vscode.WebviewEditorInset;
    try {
      inset = vscode.window.createWebviewTextEditorInset(editor, line, shown.length + (hidden > 0 ? 1 : 0), {
        enableScripts: true,
      });
      this.available = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/proposal/i.test(message)) {
        this.available = false;
        return 'unavailable';
      }
      console.warn('[redline] could not create inset:', message);
      return undefined;
    }
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    inset.webview.html = render(shown, hidden, tabSize);
    const entry: Entry = { inset, line, created: Date.now(), alive: false };
    inset.webview.onDidReceiveMessage((message) => {
      if (message === 'revert') this.onRevert(editor.document, id);
      if (message === 'pong') {
        entry.alive = true;
        clearTimeout(entry.ping);
        entry.ping = undefined;
      }
    });
    inset.onDidDispose(() => {
      clearTimeout(entry.ping);
      const entries = this.editors.get(editor);
      if (entries?.get(id) === entry) entries.delete(id);
    });
    return entry;
  }

  /** Keep our idea of each inset's line in step with the zone Monaco moved while the user typed. */
  trackEdit(e: vscode.TextDocumentChangeEvent): void {
    for (const [editor, entries] of this.editors) {
      if (editor.document !== e.document) continue;
      for (const entry of entries.values()) {
        for (const change of e.contentChanges) {
          entry.line = shiftZoneLine(entry.line, {
            start: change.range.start.line,
            end: change.range.end.line,
            insertedLines: change.text.split('\n').length - 1,
          });
        }
      }
    }
  }

  count(doc: vscode.TextDocument): number {
    let total = 0;
    for (const [editor, entries] of this.editors) if (editor.document === doc) total += entries.size;
    return total;
  }

  clear(editor?: vscode.TextEditor): void {
    for (const [e, entries] of [...this.editors]) {
      if (editor && e !== editor) continue;
      this.editors.delete(e);
      for (const entry of entries.values()) entry.inset.dispose();
    }
  }

  dispose(): void {
    this.clear();
  }
}
