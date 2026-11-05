import * as vscode from 'vscode';
import { computeHunks } from './diff';
import { isChangeRoot, overlapsHunks } from './reviewGuide';
import { ReviewSession } from './session';

export interface ChangedSymbol {
  name: string;
  kind: vscode.SymbolKind;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  changeRoot: boolean;
  callers?: vscode.CallHierarchyIncomingCall[];
  outside: vscode.CallHierarchyIncomingCall[];
  item?: vscode.CallHierarchyItem;
}

export function callKey(item: { uri: vscode.Uri; selectionRange: vscode.Range }): string {
  return `${item.uri.toString()}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
}

export const CALLABLE_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor, vscode.SymbolKind.Variable, vscode.SymbolKind.Property, vscode.SymbolKind.Field]);

/** Bound requests so a slow provider cannot block the remaining files indefinitely. */
export async function queryProvider<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      vscode.commands.executeCommand<T>(command, ...args),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 5000); }),
    ]);
  } catch {
    return undefined; // Missing providers and provider failures leave the file navigable.
  } finally {
    clearTimeout(timer);
  }
}

export interface AnalysisProgress {
  phase: 'symbols' | 'calls';
  completed: number;
  total: number;
}

async function workers<T>(items: T[], work: (item: T) => Promise<void>, cancelled: () => boolean, completed: () => void): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (index < items.length && !cancelled()) {
      await work(items[index++]);
      if (!cancelled()) completed();
    }
  }));
}

/** One snapshot per refresh; the view publishes it only if the session and documents still match. */
export async function analyzeReview(
  session: ReviewSession,
  cancelled: () => boolean,
  report: (progress: AnalysisProgress) => void,
): Promise<Map<string, ChangedSymbol[]>> {
  const result = new Map<string, ChangedSymbol[]>();
  let completedFiles = 0;
  report({ phase: 'symbols', completed: 0, total: session.files.length });
  await workers([...session.files], async (file) => {
    if (file.status === 'D') return;
    try {
      const uri = session.uriFor(file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const version = doc.version;
      const base = await session.baseFor(file.path);
      if (cancelled() || base === undefined) return;
      const hunks = computeHunks(base, doc.getText());
      const symbols = await queryProvider<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri);
      if (cancelled() || version !== doc.version) return;
      const changed: ChangedSymbol[] = [];
      const visit = (symbol: vscode.DocumentSymbol | vscode.SymbolInformation, container = '') => {
        const range = 'selectionRange' in symbol ? symbol.range : symbol.location.range;
        if (overlapsHunks(range, hunks)) {
          changed.push({
            name: container + symbol.name, kind: symbol.kind, uri, range,
            selectionRange: 'selectionRange' in symbol ? symbol.selectionRange : range,
            changeRoot: false, outside: [],
          });
        }
        if ('children' in symbol) for (const child of symbol.children) visit(child, container + symbol.name + '.');
      };
      for (const symbol of symbols ?? []) visit(symbol);
      result.set(file.path, changed);
    } catch {
      // Binary, missing, and unreadable files still appear in the file list.
    }
  }, cancelled, () => report({ phase: 'symbols', completed: ++completedFiles, total: session.files.length }));

  const symbols = [...result.values()].flat();
  const callables = symbols.filter((symbol) => CALLABLE_KINDS.has(symbol.kind));
  let completedCalls = 0;
  if (cancelled()) return result;
  report({ phase: 'calls', completed: 0, total: callables.length });
  await workers(callables, async (symbol) => {
    const items = await queryProvider<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', symbol.uri, symbol.selectionRange.start);
    if (cancelled()) return;
    // Providers can return multiple candidates; only use the declaration we asked about.
    symbol.item = items?.find((item) => item.uri.toString() === symbol.uri.toString() && symbol.range.contains(item.selectionRange.start));
    if (!symbol.item) return;
    symbol.callers = await queryProvider<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', symbol.item);
  }, cancelled, () => report({ phase: 'calls', completed: ++completedCalls, total: callables.length }));
  const ids = new Set(symbols.map((s) => callKey(s.item ?? s)));
  for (const symbol of symbols) {
    if (!symbol.item) continue;
    const id = callKey(symbol.item);
    symbol.changeRoot = isChangeRoot(id, symbol.callers?.map((c) => callKey(c.from)), ids);
    symbol.outside = (symbol.callers ?? []).filter((c) => !ids.has(callKey(c.from)));
  }
  return result;
}
