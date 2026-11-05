import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFile, DEFAULT_PATTERNS, isChangeRoot, matchesGlob, overlapsHunks } from '../src/reviewGuide.ts';

test('groups contracts, domain models, routes and tests with test precedence', () => {
  for (const file of ['schema.graphql', 'api/schema.prisma', 'src/order.entity.ts', 'src/models/order.ts', 'api/openapi.yaml', 'db/migrations/001.sql']) {
    assert.equal(classifyFile(file, DEFAULT_PATTERNS), 'shape', file);
  }
  for (const file of ['order.resolver.ts', 'src/order.controller.js', 'app/orders/route.ts', 'routes/orders.py']) {
    assert.equal(classifyFile(file, DEFAULT_PATTERNS), 'entry', file);
  }
  assert.equal(classifyFile('models/order.spec.ts', DEFAULT_PATTERNS), 'tests');
  assert.equal(classifyFile('src/service.ts', DEFAULT_PATTERNS), 'implementation');
  assert.equal(classifyFile('order.entity.ts', DEFAULT_PATTERNS), 'shape');
  assert.equal(classifyFile('src/contracts/order.ts', { ...DEFAULT_PATTERNS, shape: ['**/contracts/**'] }), 'shape');
  assert.equal(classifyFile('order.entity.ts', { ...DEFAULT_PATTERNS, shape: [] }), 'implementation');
});

test('PR 379 internal layers stay in Implementation even when a changed symbol is a graph root', () => {
  const files = [
    'apps/api/src/modules/payment/infrastructure/persistence/mappers/stored-payment-method.mapper.ts',
    'apps/api/src/modules/stripe/application/queries/thin/stripe-customer-exists/stripe-customer-exists.handler.ts',
    'apps/api/src/modules/user/application/queries/thin/get-user-id-by-stripe-customer-id/get-user-id-by-stripe-customer-id.handler.ts',
    'apps/api/src/modules/stripe/application/use-cases/upsert-processor-payment-records-for-stripe-charge/upsert-processor-payment-records-for-stripe-charge.use-case.ts',
    'apps/api/src/modules/stripe/application/use-cases/upsert-processor-payment-records-for-stripe-payment-intent/upsert-processor-payment-records-for-stripe-payment-intent.use-case.ts',
    'apps/api/src/payment/payment.service.ts',
    'apps/api/src/user/user.service.ts',
  ];
  assert.ok(isChangeRoot('helper', ['unchangedCaller'], new Set(['helper'])));
  for (const file of files) assert.equal(classifyFile(file, DEFAULT_PATTERNS), 'implementation', file);
  // A repository can deliberately choose a different application boundary.
  assert.equal(classifyFile(files[1], { ...DEFAULT_PATTERNS, entry: ['**/*.handler.ts'] }), 'entry');
});

test('globs handle root paths, alternatives and regex punctuation literally', () => {
  assert.ok(matchesGlob('schema.gql', '**/*.{graphql,gql}'));
  assert.ok(matchesGlob('test/a.ts', '**/{test,tests}/**'));
  assert.ok(matchesGlob('src/a1.ts', 'src/a?.ts'));
  assert.ok(matchesGlob('src/a[1].ts', 'src/a[1].ts'));
  assert.ok(!matchesGlob('src/a1.ts', 'src/a[1].ts'));
  assert.ok(!matchesGlob('src/deep/a.ts', 'src/*.ts'));
  assert.ok(!matchesGlob('fooXentity.ts', '*.entity.ts'));
});

test('symbol overlap respects end-exclusive spans and deletion boundaries', () => {
  const range = { start: { line: 3 }, end: { line: 7, character: 0 } };
  const add = (start: number) => [{ start, added: 1, removed: [] }];
  const del = (start: number) => [{ start, added: 0, removed: ['deleted'] }];
  assert.ok(overlapsHunks(range, add(3)));
  assert.ok(overlapsHunks(range, add(6)));
  assert.ok(!overlapsHunks(range, add(7)));
  assert.ok(!overlapsHunks(range, del(3)));
  assert.ok(overlapsHunks(range, del(5)));
});

test('change roots exclude changed callers, handle recursion, and preserve unknown results', () => {
  const changed = new Set(['root', 'helper', 'cycle']);
  assert.ok(isChangeRoot('root', ['external'], changed));
  assert.ok(isChangeRoot('root', ['root'], changed));
  assert.ok(isChangeRoot('root', [], changed));
  assert.ok(!isChangeRoot('helper', ['root'], changed));
  assert.ok(!isChangeRoot('helper', ['cycle'], changed));
  assert.ok(!isChangeRoot('cycle', ['helper'], changed));
  assert.ok(!isChangeRoot('root', undefined, changed));
});
