/** UTF-16 offsets of the invoked identifier within a provider's callee or invocation span. */
export function callNameSpan(text: string): { start: number; end: number } | undefined {
  // Providers disagree on whether a call range covers `method`, `this.service.method`,
  // or the invocation including arguments. Ignore strings/comments and nested arguments.
  const tokens = text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[$_\p{ID_Start}][$_\p{ID_Continue}]*|\S/gu);
  const nesting: string[] = [];
  let genericDepth = 0;
  let name: { start: number; end: number } | undefined;
  let invoked: typeof name;
  for (const token of tokens) {
    const value = token[0];
    if (value.startsWith('//') || value.startsWith('/*')) continue;
    if (nesting.length) {
      if (['(', '[', '{'].includes(value)) nesting.push(value);
      else if ([')', ']', '}'].includes(value)) nesting.pop();
      continue;
    }
    if (genericDepth) {
      if (value === '<') genericDepth++;
      else if (value === '>') genericDepth--;
      continue;
    }
    if (value === '<' && name) { genericDepth = 1; continue; }
    if (value === '(') {
      invoked = name;
      name = undefined;
      nesting.push(value);
    } else if (value === '[' || value === '{') {
      name = undefined;
      nesting.push(value);
    } else if (/^[$_\p{ID_Start}]/u.test(value)) {
      name = { start: token.index!, end: token.index! + value.length };
    } else if (!['.', '?', '!'].includes(value)) {
      name = undefined;
    }
  }
  // A terminal member name takes precedence over an earlier receiver call: factory().method.
  if (name) return name;
  return /\)\s*;?\s*$/.test(text) ? invoked : undefined;
}
