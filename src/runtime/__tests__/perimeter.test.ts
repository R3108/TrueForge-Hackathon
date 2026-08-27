import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkPerimeter, isInsidePerimeter, normalizePath, globToRegExp } from '../perimeter.ts';

/**
 * The perimeter exists so the agent cannot rewrite the gate that restrains it.
 * These tests are the reason anyone should believe that claim.
 */

const PERIMETER = ['fixture/**'];

describe('normalizePath', () => {
  test('strips leading ./ and duplicate separators', () => {
    assert.equal(normalizePath('./fixture//src/cart.js'), 'fixture/src/cart.js');
  });

  test('accepts Windows separators', () => {
    assert.equal(normalizePath('fixture\\src\\cart.js'), 'fixture/src/cart.js');
  });

  test('resolves .. inside the tree', () => {
    assert.equal(normalizePath('fixture/src/../cart.js'), 'fixture/cart.js');
  });

  test('refuses a path that climbs above the repository root', () => {
    assert.equal(normalizePath('../../etc/passwd'), undefined);
  });
});

describe('globToRegExp', () => {
  test('* does not cross a separator', () => {
    assert.ok(globToRegExp('fixture/*.js').test('fixture/cart.js'));
    assert.ok(!globToRegExp('fixture/*.js').test('fixture/src/cart.js'));
  });

  test('** crosses separators', () => {
    assert.ok(globToRegExp('fixture/**').test('fixture/src/deep/cart.js'));
  });

  test('is anchored at both ends', () => {
    assert.ok(!globToRegExp('fixture/**').test('src/fixture/spec.ts'));
  });
});

describe('isInsidePerimeter', () => {
  test('admits a path inside the perimeter', () => {
    assert.ok(isInsidePerimeter('fixture/src/cart.js', PERIMETER));
  });

  test('rejects the agent\'s own source', () => {
    assert.ok(!isInsidePerimeter('src/agent/spec.ts', PERIMETER));
  });

  test('rejects a traversal that lands outside', () => {
    assert.ok(
      !isInsidePerimeter('fixture/../src/runtime/approvals.ts', PERIMETER),
      'a perimeter that can be walked out of with ../ is not a perimeter',
    );
  });

  test('admits a traversal that stays inside', () => {
    assert.ok(isInsidePerimeter('fixture/src/../cart.js', PERIMETER));
  });
});

describe('checkPerimeter', () => {
  test('blocks a write to the approval gate itself', () => {
    const verdict = checkPerimeter(
      { path: 'src/runtime/approvals.ts', content: '// trust me' },
      PERIMETER,
    );

    assert.equal(verdict.status, 'blocked');
    assert.deepEqual(
      verdict.status === 'blocked' ? verdict.offending : [],
      ['src/runtime/approvals.ts'],
    );
  });

  test('allows a write inside the fixture', () => {
    assert.equal(checkPerimeter({ path: 'fixture/src/cart.js' }, PERIMETER).status, 'allowed');
  });

  test('blocks a multi-file push if any single file escapes', () => {
    const verdict = checkPerimeter(
      {
        files: [
          { path: 'fixture/src/cart.js', content: 'ok' },
          { path: 'src/agent/spec.ts', content: 'not ok' },
        ],
      },
      PERIMETER,
    );

    assert.equal(verdict.status, 'blocked', 'one bad file must sink the whole call');
    assert.deepEqual(verdict.status === 'blocked' ? verdict.offending : [], ['src/agent/spec.ts']);
  });

  test('is inert when no perimeter is declared', () => {
    assert.equal(checkPerimeter({ path: 'src/agent/spec.ts' }, []).status, 'allowed');
  });

  test('ignores calls that carry no paths', () => {
    assert.equal(
      checkPerimeter({ title: 'Fix null deref', head: 'fix/x' }, PERIMETER).status,
      'allowed',
      'opening a pull request is not the perimeter\'s business',
    );
  });

  test('survives malformed arguments', () => {
    assert.doesNotThrow(() => checkPerimeter(null, PERIMETER));
    assert.doesNotThrow(() => checkPerimeter({ files: 'not-an-array' }, PERIMETER));
  });
});
