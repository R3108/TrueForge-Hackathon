import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { preview } from '../render.ts';

describe('preview', () => {
  test('leaves short values intact', () => {
    assert.equal(preview('create_branch', 400), 'create_branch');
  });

  test('truncates long values so a file body cannot flood the terminal', () => {
    const long = 'x'.repeat(5000);
    const out = preview(long, 100);

    assert.ok(out.startsWith('x'.repeat(100)), 'keeps the first N characters');
    assert.ok(out.length < long.length, 'must be shorter than the input');
    assert.match(out, /4900 more chars/, 'tells the reader how much was hidden');
  });

  test('pretty-prints objects so approval arguments stay readable', () => {
    const out = preview({ title: 'Fix null deref', branch: 'fix/abc-null-deref' });

    assert.match(out, /"title": "Fix null deref"/);
    assert.match(out, /\n/, 'objects should be formatted across lines, not inlined');
  });

  test('survives values that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    assert.doesNotThrow(() => preview(circular));
  });

  test('renders null and undefined without throwing', () => {
    assert.doesNotThrow(() => preview(null));
    assert.doesNotThrow(() => preview(undefined));
  });
});
