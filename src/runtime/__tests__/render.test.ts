import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { preview, numberLines, summarizeCall, summarizeInline, payloadsIn } from '../render.ts';

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

describe('numberLines', () => {
  test('numbers every line so a reviewer can cite one', () => {
    const out = numberLines('alpha\nbravo\ncharlie');

    assert.match(out, /1 .*alpha/);
    assert.match(out, /3 .*charlie/);
  });

  test('caps by whole lines, never mid-token', () => {
    const out = numberLines(Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n'), 5);

    assert.ok(out.includes('line4'), 'keeps the first N lines');
    assert.ok(!out.includes('line5'), 'drops the rest');
    assert.match(out, /35 more lines/, 'says how much was hidden');
  });
});

describe('summarizeCall', () => {
  test('locates a file write by repo, branch and path', () => {
    const { fields } = summarizeCall('create_or_update_file', {
      owner: 'R3108',
      repo: 'TrueForge-Hackathon',
      branch: 'fix/abc-null-deref',
      path: 'src/cart.ts',
      content: 'export const total = 1;',
    });

    assert.deepEqual(
      fields.filter(([label]) => ['repo', 'branch', 'path'].includes(label)),
      [
        ['repo', 'R3108/TrueForge-Hackathon'],
        ['branch', 'fix/abc-null-deref'],
        ['path', 'src/cart.ts'],
      ],
    );
  });

  test('surfaces the file content as the reviewable body', () => {
    const { bodies } = summarizeCall('create_or_update_file', {
      path: 'src/cart.ts',
      content: 'line one\nline two',
    });

    assert.equal(bodies[0]?.text, 'line one\nline two');
  });

  test('flags a write that touches CI configuration', () => {
    const { risks } = summarizeCall('create_or_update_file', {
      path: '.github/workflows/ci.yml',
      content: 'on: push',
    });

    assert.match(risks.join(' '), /CI/i, 'a workflow edit must not look routine');
  });

  test('flags a dependency change', () => {
    const { risks } = summarizeCall('push_files', {
      files: [{ path: 'package.json', content: '{}' }],
    });

    assert.match(risks.join(' '), /dependenc/i);
  });

  test('flags destructive tools even with innocuous arguments', () => {
    const { risks } = summarizeCall('merge_pull_request', { pull_number: 7 });

    assert.match(risks.join(' '), /merges into the base branch/);
  });

  test('counts every file in a multi-file push', () => {
    const { fields } = summarizeCall('push_files', {
      files: [
        { path: 'src/cart.ts', content: 'a' },
        { path: 'src/cart.test.ts', content: 'b' },
      ],
    });

    const files = fields.find(([label]) => label === 'files')?.[1] ?? '';
    assert.match(files, /^2 · /, 'the operator must see how many files are in one approval');
    assert.match(files, /cart\.test\.ts/);
  });

  test('survives a tool it has never seen', () => {
    assert.doesNotThrow(() => summarizeCall('some_future_tool', { wat: 1 }));
    assert.doesNotThrow(() => summarizeCall('create_branch', null));
  });
});

describe('payloadsIn', () => {
  test('collects every file body, not just the one on screen', () => {
    const payloads = payloadsIn({
      files: [
        { path: 'fixture/src/cart.js', content: 'a' },
        { path: 'fixture/src/client.js', content: 'b' },
      ],
    });

    assert.deepEqual(
      payloads.map((payload) => payload.label),
      ['fixture/src/cart.js', 'fixture/src/client.js'],
      'the scanner must see the file the reviewer never scrolled to',
    );
  });

  test('labels a single file body with its path', () => {
    assert.deepEqual(payloadsIn({ path: 'fixture/a.js', content: 'x' }), [
      { label: 'fixture/a.js', text: 'x' },
    ]);
  });

  test('includes prose destined for the repository', () => {
    const labels = payloadsIn({
      title: 'Fix null deref',
      body: 'Root cause: …',
      message: 'fix: guard against a missing cart',
    }).map((payload) => payload.label);

    // Titles are persisted exactly like bodies. Omitting them left a place to
    // put a token that the tripwire would never look at.
    assert.deepEqual(labels, ['body', 'message', 'title']);
  });

  test('includes the branch name, which is also written to the repository', () => {
    assert.deepEqual(payloadsIn({ branch: 'fix/x', base: 'main' }), [
      { label: 'branch', text: 'fix/x' },
    ]);
  });

  test('returns nothing for a call that writes no text at all', () => {
    assert.deepEqual(payloadsIn({ base: 'main', owner: 'R3108', repo: 'x' }), []);
  });
});

describe('summarizeInline', () => {
  test('names the path a call touches', () => {
    assert.match(
      summarizeInline('create_or_update_file', { path: 'src/cart.ts' }),
      /create_or_update_file.*src\/cart\.ts/,
    );
  });

  test('falls back to the bare tool name', () => {
    assert.equal(summarizeInline('create_branch', { branch: 'fix/x' }), 'create_branch');
  });
});
