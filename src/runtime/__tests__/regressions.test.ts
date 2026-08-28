import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { globToRegExp, isInsidePerimeter } from '../perimeter.ts';
import { payloadsIn, summarizeCall } from '../render.ts';
import { scanPayloads } from '../secrets.ts';

/**
 * Regressions for the findings Qodo raised on PRs #3 and #4.
 *
 * Each of these was a way for a write to reach the repository without being
 * checked or without being seen. They are grouped here, rather than scattered
 * into the module suites, so that the cost of losing one of them is obvious.
 */

describe('globstar spans whole path segments', () => {
  test('a/**/b does not match a suffix inside a filename', () => {
    const pattern = globToRegExp('safe/**/config.json');

    assert.ok(pattern.test('safe/config.json'), 'zero intermediate segments');
    assert.ok(pattern.test('safe/x/y/config.json'), 'several intermediate segments');
    assert.ok(
      !pattern.test('safe/evilconfig.json'),
      'a filename ending in the literal must not match - this widened the allowlist',
    );
  });

  test('trailing ** still matches everything below', () => {
    assert.ok(isInsidePerimeter('fixture/src/deep/cart.js', ['fixture/**']));
    assert.ok(!isInsidePerimeter('fixtures-other/cart.js', ['fixture/**']));
  });

  test('a single star stays inside one segment', () => {
    const pattern = globToRegExp('src/*.ts');

    assert.ok(pattern.test('src/config.ts'));
    assert.ok(!pattern.test('src/nested/config.ts'));
  });
});

describe('credential tripwire covers every persisted field', () => {
  const token = `gh${'p'}_${'a1B2c3D4e5F6g7H8i9J0'}${'kLmNoPqRsTuVwXyZ0123'}`;

  test('scans the title, not only the body', () => {
    const findings = scanPayloads(payloadsIn({ title: `fix: rotate ${token}`, body: 'clean' }));

    assert.equal(findings.length, 1, 'a token in a PR title is persisted just like one in a body');
    assert.equal(findings[0]?.where, 'title');
  });

  test('scans the branch name', () => {
    const findings = scanPayloads(payloadsIn({ branch: `fix/${token}` }));
    assert.equal(findings.length, 1);
  });
});

describe('approval summaries show the whole write', () => {
  test('renders content for every file in a multi-file push', () => {
    const summary = summarizeCall('push_files', {
      files: [
        { path: 'a.js', content: 'const a = 1;' },
        { path: 'b.js', content: 'const b = 2;' },
        { path: 'c.js', content: 'const c = 3;' },
      ],
    });

    assert.equal(summary.bodies.length, 3, 'one approval authorises all three files');
    assert.ok(summary.bodies.some((b) => b.text === 'const c = 3;'), 'the last file must be shown');
  });

  test('an empty write is shown as an erasure, not omitted', () => {
    const summary = summarizeCall('create_or_update_file', {
      path: 'src/index.ts',
      content: '',
    });

    assert.equal(summary.bodies.length, 1, 'writing "" erases a file - it is not "no payload"');
    assert.match(summary.bodies[0]?.label ?? '', /empty/i);
    assert.ok(
      summary.risks.some((risk) => /empty/i.test(risk)),
      'and it should be called out as a risk',
    );
  });

  test('a whitespace-only write is still an erasure', () => {
    const summary = summarizeCall('create_or_update_file', { path: 'x.ts', content: '   \n  ' });
    assert.equal(summary.bodies.length, 1);
    assert.match(summary.bodies[0]?.label ?? '', /empty/i);
  });
});
