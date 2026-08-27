import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scanForSecrets, scanPayloads, parseSecretPolicy } from '../secrets.ts';

/**
 * Every credential in this file is assembled at runtime from harmless pieces.
 * A test fixture that is *literally* a token-shaped string gets flagged by
 * GitHub's push protection and by every other scanner in the ecosystem - which
 * would make the tests for our scanner unpushable.
 */
const githubToken = `gh${'p'}_${'a1B2c3D4e5F6g7H8i9J0'}${'kLmNoPqRsTuVwXyZ0123'}`;
const awsKey = `AK${'IA'}${'ABCDEFGHIJKLMNOP'}`;
const jwt = `ey${'JhbGciOiJIUzI1NiJ9'}.${'eyJzdWIiOiIxMjM0NTY3ODkw'}.${'dQw4w9WgXcQaBcDeFg'}`;

describe('scanForSecrets', () => {
  test('recognises a GitHub token by its issuer prefix', () => {
    const [finding] = scanForSecrets(`const auth = "${githubToken}";`);

    assert.equal(finding?.label, 'GitHub personal access token');
    assert.equal(finding?.line, 1);
  });

  test('never repeats the secret back in the finding', () => {
    const [finding] = scanForSecrets(githubToken);

    assert.ok(finding);
    assert.ok(!finding.redacted.includes(githubToken.slice(8)), 'a leak report must not leak');
    assert.match(finding.redacted, /\*{3,}/);
  });

  test('reports the line so a reviewer can go and look', () => {
    const [finding] = scanForSecrets(['line one', 'line two', `key = "${awsKey}"`].join('\n'));

    assert.equal(finding?.line, 3);
  });

  test('recognises a private key block and a JWT', () => {
    assert.equal(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----').length, 1);
    assert.equal(scanForSecrets(`Authorization: Bearer ${jwt}`).length, 1);
  });

  test('flags a hardcoded credential assignment', () => {
    const [finding] = scanForSecrets('const client_secret = "8f3aB91xQ0zLp7vN2sYc";');

    assert.equal(finding?.label, 'hardcoded credential assignment');
  });

  test('ignores a value read from the environment', () => {
    assert.deepEqual(scanForSecrets('const token = process.env.GITHUB_TOKEN;'), []);
    assert.deepEqual(scanForSecrets('api_key: "${GITHUB_TOKEN}"'), []);
  });

  test('ignores documentation placeholders', () => {
    assert.deepEqual(scanForSecrets('GITHUB_TOKEN="your-token-here"'), []);
    assert.deepEqual(scanForSecrets('password = "xxxxxxxxxxxxxxxxxx"'), []);
    assert.deepEqual(scanForSecrets('secret: "<paste yours here>"'), []);
  });

  test('does not fire on ordinary source code', () => {
    const source = [
      'export function total(items) {',
      '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
      '}',
    ].join('\n');

    assert.deepEqual(scanForSecrets(source), []);
  });

  test('reports one finding per kind, not one per occurrence', () => {
    const findings = scanForSecrets(`${githubToken}\n${githubToken}\n${githubToken}`);

    assert.equal(findings.length, 1, 'forty JWTs in one file is still one problem');
  });

  test('is safe on an empty payload', () => {
    assert.deepEqual(scanForSecrets(''), []);
  });
});

describe('scanPayloads', () => {
  test('says which payload the credential was in', () => {
    const [finding] = scanPayloads([
      { label: 'fixture/src/cart.js', text: 'const total = 1;' },
      { label: 'fixture/src/client.js', text: `const auth = "${githubToken}";` },
    ]);

    assert.equal(finding?.where, 'fixture/src/client.js');
  });
});

describe('parseSecretPolicy', () => {
  test('defaults to blocking, including for nonsense values', () => {
    assert.equal(parseSecretPolicy(undefined), 'block');
    assert.equal(parseSecretPolicy(''), 'block');
    assert.equal(parseSecretPolicy('maybe'), 'block');
  });

  test('accepts the two deliberate relaxations', () => {
    assert.equal(parseSecretPolicy('warn'), 'warn');
    assert.equal(parseSecretPolicy(' OFF '), 'off');
  });
});
