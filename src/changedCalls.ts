import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';
import { callNameSpan } from './callName';
import { CALLABLE_KINDS, ChangedSymbol, queryProvider } from './reviewAnalysis';

export interface ChangedCall {
  range: vscode.Range;
  target: ChangedSymbol;
  possible: boolean;
}

/** Call markers consume completed review snapshots and never change the review tree. */
export class ChangedCalls implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('redline.changedCallForeground'),
    textDecoration: 'underline',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly subscriptions: vscode.Disposable[];
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private uris = new Map<string, string>();
  private targets = new Map<string, ChangedSymbol>();
  private incoming = new Map<string, ChangedCall[]>();
  private discovered = new Map<string, Map<string, ChangedCall[]>>();
  private tasks = new Map<string, Promise<ChangedCall[]>>();
  private documents = new Map<string, Promise<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>>();
  private implementations = new Map<string, Promise<(vscode.Location | vscode.LocationLink)[] | undefined>>();
  private readonly decorated = new Set<vscode.TextEditor>();

  constructor() {
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refreshVisible(), 100);
    };
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(schedule),
      vscode.window.onDidChangeTextEditorVisibleRanges(schedule),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('redline.changedCalls')) this.refreshVisible();
      }),
    ];
  }

  private uriKey(uri: vscode.Uri): string {
    const key = uri.toString();
    let canonical = this.uris.get(key);
    if (!canonical) {
      canonical = key;
      if (uri.scheme === 'file') {
        try { canonical = vscode.Uri.file(realpathSync.native(uri.fsPath)).toString(); } catch { /* New or removed file. */ }
      }
      this.uris.set(key, canonical);
    }
    return canonical;
  }

  private symbolKey(item: { uri: vscode.Uri; selectionRange: vscode.Range }): string {
    return `${this.uriKey(item.uri)}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
  }

  setSymbols(symbols?: Map<string, ChangedSymbol[]>): void {
    this.generation++;
    clearTimeout(this.timer);
    this.uris.clear();
    this.targets.clear();
    this.incoming.clear();
    this.discovered.clear();
    this.tasks.clear();
    this.documents.clear();
    this.implementations.clear();
    for (const symbol of [...(symbols?.values() ?? [])].flat()) {
      if (!symbol.item) continue;
      this.targets.set(this.symbolKey(symbol.item), symbol);
      for (const caller of symbol.callers ?? []) {
        const key = this.uriKey(caller.from.uri);
        const marks = this.incoming.get(key) ?? [];
        marks.push(...caller.fromRanges.map((range) => ({ range, target: symbol, possible: false })));
        this.incoming.set(key, marks);
      }
    }
    // Also clear editors that just became hidden; they may become visible again later.
    for (const editor of this.decorated) editor.setDecorations(this.decoration, []);
    this.decorated.clear();
    this.refreshVisible();
  }

  /** The same marker data used to paint the editor, exposed for integration verification. */
  markers(document: vscode.TextDocument): ChangedCall[] {
    if (!vscode.workspace.getConfiguration('redline', document.uri).get('changedCalls', true)) return [];
    const key = this.uriKey(document.uri);
    const unique = new Map<string, ChangedCall>();
    const outgoing = [...(this.discovered.get(key)?.values() ?? [])].flat();
    for (const mark of [...outgoing, ...(this.incoming.get(key) ?? [])]) {
      const range = document.validateRange(mark.range);
      const name = callNameSpan(document.getText(range));
      if (!name) continue;
      const start = document.offsetAt(range.start);
      const identifier = new vscode.Range(document.positionAt(start + name.start), document.positionAt(start + name.end));
      const id = `${identifier.start.line}:${identifier.start.character}:${identifier.end.line}:${identifier.end.character}:${this.symbolKey(mark.target.item!)}`;
      const previous = unique.get(id);
      // Normalize before deduplicating: incoming and outgoing providers can report different
      // enclosing spans for the same identifier. Prefer a directly reported target.
      if (!previous || previous.possible) unique.set(id, { ...mark, range: identifier });
    }
    return [...unique.values()];
  }

  decorationOptions(document: vscode.TextDocument): vscode.DecorationOptions[] {
    const calls = new Map<string, ChangedCall[]>();
    for (const mark of this.markers(document)) {
      const key = `${mark.range.start.line}:${mark.range.start.character}:${mark.range.end.line}:${mark.range.end.character}`;
      const targets = calls.get(key) ?? [];
      targets.push(mark);
      calls.set(key, targets);
    }
    return [...calls.values()].map((targets) => {
      const hover = new vscode.MarkdownString('**Redline: changed call target in this review.**\n\n');
      for (const mark of targets) {
        hover.appendText(mark.target.name + (mark.possible ? ' (possible implementation)' : ''));
        hover.appendMarkdown('\n\n');
        const uri = mark.target.uri.with({ fragment: `L${mark.target.selectionRange.start.line + 1}` });
        hover.appendMarkdown(`[Open changed declaration](${uri.toString()})\n\n`);
      }
      return { range: targets[0].range, hoverMessage: hover };
    });
  }

  private apply(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decoration, editor.viewColumn === undefined ? [] : this.decorationOptions(editor.document));
    this.decorated.add(editor);
  }

  private refreshVisible(): void {
    const visible = new Set(vscode.window.visibleTextEditors);
    for (const editor of this.decorated) {
      if (!visible.has(editor)) {
        editor.setDecorations(this.decoration, []);
        this.decorated.delete(editor);
      }
    }
    for (const editor of visible) {
      this.apply(editor);
      if (editor.viewColumn === undefined || editor.document.uri.scheme !== 'file' || !this.targets.size
        || !vscode.workspace.getConfiguration('redline', editor.document.uri).get('changedCalls', true)) continue;
      void this.discover(editor).catch((error) => console.warn('[redline] call markers failed:', error));
    }
  }

  private async discover(editor: vscode.TextEditor): Promise<void> {
    const generation = this.generation;
    const document = editor.document;
    const version = document.version;
    const current = () => generation === this.generation && version === document.version && !document.isClosed;
    const key = this.uriKey(document.uri);
    const docKey = `${key}:${version}`;
    let documentSymbols = this.documents.get(docKey);
    if (!documentSymbols) {
      documentSymbols = queryProvider<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', document.uri);
      this.documents.set(docKey, documentSymbols);
    }
    const symbols = await documentSymbols;
    if (!current()) return;
    const work: { range: vscode.Range; selection: vscode.Range }[] = [];
    const visit = (symbol: vscode.DocumentSymbol | vscode.SymbolInformation) => {
      const range = 'selectionRange' in symbol ? symbol.range : symbol.location.range;
      if (CALLABLE_KINDS.has(symbol.kind) && editor.visibleRanges.some((visible) => !!range.intersection(visible))) {
        work.push({ range, selection: 'selectionRange' in symbol ? symbol.selectionRange : range });
      }
      if ('children' in symbol) symbol.children.forEach(visit);
    };
    (symbols ?? []).forEach(visit);
    // Cache each function's outgoing calls for this snapshot. Scrolling or splitting an editor
    // reuses existing work; only newly visible functions need more provider requests.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, work.length) }, async () => {
      while (index < work.length && current()) {
        const symbol = work[index++];
        const taskKey = `${docKey}:${symbol.selection.start.line}:${symbol.selection.start.character}`;
        let task = this.tasks.get(taskKey);
        if (!task) {
          task = this.outgoing(document.uri, symbol.range, symbol.selection, current);
          this.tasks.set(taskKey, task);
        }
        const marks = await task;
        if (!current()) return;
        const functions = this.discovered.get(key) ?? new Map<string, ChangedCall[]>();
        functions.set(taskKey, marks);
        this.discovered.set(key, functions);
      }
    }));
    if (current()) {
      for (const visible of vscode.window.visibleTextEditors) {
        if (visible.document === document) this.apply(visible);
      }
    }
  }

  private async outgoing(uri: vscode.Uri, range: vscode.Range, selection: vscode.Range, current: () => boolean): Promise<ChangedCall[]> {
    const prepared = await queryProvider<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, selection.start);
    if (!current()) return [];
    const item = prepared?.find((candidate) => this.uriKey(candidate.uri) === this.uriKey(uri) && range.contains(candidate.selectionRange.start));
    if (!item) return [];
    const calls = await queryProvider<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item);
    const marks: ChangedCall[] = [];
    for (const call of calls ?? []) {
      if (!current()) break;
      const direct = this.targets.get(this.symbolKey(call.to));
      if (direct) {
        marks.push(...call.fromRanges.map((range) => ({ range, target: direct, possible: false })));
        continue;
      }
      // Names only narrow implementation lookups; a provider-reported declaration range must
      // still match. This avoids querying implementations for every unchanged library call.
      const candidates = [...this.targets.values()].filter((target) => target.item?.name === call.to.name);
      if (!candidates.length) continue;
      const key = this.symbolKey(call.to);
      let request = this.implementations.get(key);
      if (!request) {
        request = queryProvider<(vscode.Location | vscode.LocationLink)[]>(
          'vscode.executeImplementationProvider', call.to.uri, call.to.selectionRange.start);
        this.implementations.set(key, request);
      }
      const implementations = await request;
      if (!current()) break;
      for (const location of implementations ?? []) {
        const targetUri = 'targetUri' in location ? location.targetUri : location.uri;
        const targetRange = 'targetUri' in location ? location.targetSelectionRange ?? location.targetRange : location.range;
        for (const target of candidates) {
          if (this.uriKey(target.uri) === this.uriKey(targetUri) && targetRange.contains(target.selectionRange.start)) {
            marks.push(...call.fromRanges.map((range) => ({ range, target, possible: true })));
          }
        }
      }
    }
    return marks;
  }

  dispose(): void {
    this.setSymbols();
    clearTimeout(this.timer);
    this.decoration.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}
