import { diffLines, diffWordsWithSpace } from 'diff';

/** One contiguous change between the base text and the current text. */
export interface Hunk {
  /** 0-based line in the current text where the added lines start, or where the removed lines used to be. */
  start: number;
  /** Number of added lines in the current text, starting at `start`. */
  added: number;
  /** Lines that existed in the base text and are gone now. */
  removed: string[];
}

/** A range inside a single line of the current text, 0-based and end-exclusive. */
export interface LineRange {
  line: number;
  startChar: number;
  endChar: number;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface ChangedFile {
  status: FileStatus;
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Path in the base revision when the file was renamed or copied. */
  oldPath?: string;
}

function normalize(text: string): string {
  const lf = text.replace(/\r\n?/g, '\n');
  return lf === '' || lf.endsWith('\n') ? lf : lf + '\n';
}

export function splitLines(text: string): string[] {
  const lf = normalize(text);
  return lf === '' ? [] : lf.slice(0, -1).split('\n');
}

/**
 * Line diff between `base` and `current`. Line endings and a missing final newline are ignored.
 * If the diff takes longer than `timeoutMs`, the whole file is reported as one replaced hunk.
 */
export function computeHunks(base: string, current: string, timeoutMs = 1000): Hunk[] {
  const a = normalize(base);
  const b = normalize(current);
  if (a === b) return [];

  const changes = diffLines(a, b, { timeout: timeoutMs });
  if (!changes) {
    return [{ start: 0, added: splitLines(b).length, removed: splitLines(a) }];
  }

  const hunks: Hunk[] = [];
  let line = 0;
  let open: Hunk | undefined;
  for (const change of changes) {
    const count = change.count ?? splitLines(change.value).length;
    if (change.added) {
      open ??= { start: line, added: 0, removed: [] };
      open.added += count;
      line += count;
    } else if (change.removed) {
      open ??= { start: line, added: 0, removed: [] };
      open.removed.push(...splitLines(change.value));
    } else {
      if (open) hunks.push(open);
      open = undefined;
      line += count;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

/**
 * An id per hunk with removed lines, or undefined for pure additions. Ids depend only on the
 * removed text, so a block keeps its id while the user edits elsewhere in the file.
 */
export function removedBlockIds(hunks: Hunk[]): (string | undefined)[] {
  const occurrences = new Map<string, number>();
  return hunks.map((hunk) => {
    if (hunk.removed.length === 0) return undefined;
    const text = hunk.removed.join('\n');
    const n = occurrences.get(text) ?? 0;
    occurrences.set(text, n + 1);
    return `${n}:${text}`;
  });
}

/**
 * Word-level ranges inside the added lines of a modified hunk. Returns nothing for hunks that are
 * pure additions or deletions, for large hunks, and for hunks where old and new text share too
 * little to make word highlights useful.
 */
export function wordChanges(hunk: Hunk, currentLines: string[], maxLines = 40): LineRange[] {
  if (hunk.added === 0 || hunk.removed.length === 0) return [];
  if (hunk.added > maxLines || hunk.removed.length > maxLines) return [];

  const oldText = hunk.removed.join('\n');
  const newText = currentLines.slice(hunk.start, hunk.start + hunk.added).join('\n');
  const parts = diffWordsWithSpace(oldText, newText);

  const common = parts.filter((p) => !p.added && !p.removed && p.value.trim() !== '');
  const commonLength = common.reduce((sum, p) => sum + p.value.length, 0);
  if (commonLength < newText.length * 0.25) return [];

  const ranges: LineRange[] = [];
  let line = hunk.start;
  let char = 0;
  for (const part of parts) {
    if (part.removed) continue;
    const segments = part.value.split('\n');
    segments.forEach((segment, i) => {
      if (i > 0) {
        line++;
        char = 0;
      }
      if (part.added && segment.trim() !== '') {
        ranges.push({ line, startChar: char, endChar: char + segment.length });
      }
      char += segment.length;
    });
  }
  return ranges;
}

/**
 * Where Monaco moves a view zone when text changes. Zones sit below a line and shift with
 * inserted and deleted lines, the same way `LinesLayout` adjusts its whitespaces.
 */
export function shiftZoneLine(line: number, change: { start: number; end: number; insertedLines: number }): number {
  if (line <= change.start) return line;
  let shifted = line <= change.end ? change.start : line - (change.end - change.start);
  if (shifted > change.start) shifted += change.insertedLines;
  return shifted;
}

/** Parses `git diff --name-status -z` output. */
export function parseNameStatus(output: string): ChangedFile[] {
  const tokens = output.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) continue;
    const status = code[0] as FileStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      files.push({ status, path, oldPath });
    } else {
      files.push({ status, path: tokens[i++] });
    }
  }
  return files;
}
