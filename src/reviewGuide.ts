import type { Hunk } from './diff';

export type ReviewGroup = 'shape' | 'entry' | 'implementation' | 'tests';
export const GROUP_LABELS: Record<ReviewGroup, string> = {
  shape: 'Shape', entry: 'Entry points', implementation: 'Implementation', tests: 'Tests',
};
export const DEFAULT_PATTERNS = {
  shape: ['**/*.{graphql,gql,prisma}', '**/*.{entity,dto,model}.ts', '**/migrations/**', '**/entities/**', '**/models/**', '**/openapi*.{yaml,yml,json}', '**/swagger*.{yaml,yml,json}'],
  entry: ['**/*.{resolver,controller}.{ts,js}', '**/routes/**', '**/pages/api/**', '**/app/**/route.{ts,js}'],
  tests: ['**/*.{test,spec}.{ts,tsx,js,jsx}', '**/{test,tests,__tests__}/**'],
};

/** Repository-relative globs: *, **, ?, and brace alternatives. No filesystem access. */
export function matchesGlob(file: string, glob: string): boolean {
  const brace = /\{([^{}]+)\}/.exec(glob);
  if (brace) return brace[1].split(',').some((part) => matchesGlob(file, glob.slice(0, brace.index) + part + glob.slice(brace.index + brace[0].length)));
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { source += '(?:.*/)?'; i++; }
      else source += '.*';
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$').test(file);
}

export function classifyFile(file: string, patterns: typeof DEFAULT_PATTERNS): ReviewGroup {
  if (patterns.tests.some((p) => matchesGlob(file, p))) return 'tests';
  if (patterns.shape.some((p) => matchesGlob(file, p))) return 'shape';
  if (patterns.entry.some((p) => matchesGlob(file, p))) return 'entry';
  return 'implementation';
}

export interface LineSpan { start: { line: number }; end: { line: number; character: number } }

export function overlapsHunks(range: LineSpan, hunks: Hunk[]): boolean {
  const end = range.end.line - (range.end.character === 0 && range.end.line > range.start.line ? 1 : 0);
  return hunks.some((h) => h.added > 0
    ? h.start <= end && h.start + h.added > range.start.line
    // A deletion at the start belongs to the preceding gap, not the following declaration.
    : h.start > range.start.line && h.start <= end);
}

/** A root in the reported changed-call graph is a reading hint, not an application entry point. */
export function isChangeRoot(id: string, incoming: string[] | undefined, changed: Set<string>): boolean {
  return incoming !== undefined && !incoming.some((caller) => caller !== id && changed.has(caller));
}
