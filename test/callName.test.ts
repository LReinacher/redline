import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { callNameSpan } from '../src/callName.ts';

function name(text: string): string | undefined {
  const span = callNameSpan(text);
  return span && text.slice(span.start, span.end);
}

test('decorates only the name within qualified provider ranges', () => {
  for (const text of [
    'this.eventService.leaveEventSelfInitiated',
    'this.leaveEventSelfInitiated',
    'eventService?.leaveEventSelfInitiated',
    'this\n  .eventService\n  .leaveEventSelfInitiated',
    'factory().leaveEventSelfInitiated',
    'services[selectService()].leaveEventSelfInitiated',
    'this.leaveEventSelfInitiated<Result<Item>>',
  ]) assert.equal(name(text), 'leaveEventSelfInitiated', text);
});

test('handles invocation spans without coloring arguments, receiver calls or type parameters', () => {
  for (const text of [
    'this.leave<Result>({ event: getEvent() })',
    'this.leave?.(event)',
    'this.leave(event);',
    'factory().leave(other())',
    'this.leave({ text: "nested()", template: `value(${ignored()})` })',
    'this.leave(/* comment() */ event)',
  ]) assert.equal(name(text), 'leave', text);
});

test('keeps aliases and Unicode names and skips spans without a named call', () => {
  assert.equal(name('importedAlias()'), 'importedAlias');
  assert.equal(name('repo.ändern()'), 'ändern');
  assert.equal(name('repo.$save()'), '$save');
  assert.equal(name('repo[methodName](event)'), undefined);
  assert.equal(name(''), undefined);
  assert.equal(name('   '), undefined);
  assert.equal(name('"notACall"'), undefined);
});
