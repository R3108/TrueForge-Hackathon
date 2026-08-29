import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

import { checkPerimeterConfig, connectorAuthVerdict } from '../doctor.ts';
import type { Config } from '../../config.ts';
import { parseSecretPolicy } from '../../runtime/secrets.ts';

/**
 * Doctor's verdicts are the last thing between an operator and a recorded demo
 * that dies of a predictable failure. These tests pin the two that Qodo found
 * were silently green when they should not have been.
 */

const config = (writePaths: string[]): Config => ({
  baseUrl: 'http://localhost:8790',
  token: undefined,
  model: 'openai/gpt-5-6-terra',
  targetRepo: 'R3108/cart-service',
  baseBranch: 'main',
  writePaths,
  policyVersion: 'ltp-firewall-v1',
  targetedTestCommand: 'npm test',
  fullSuiteCommand: 'npm test',
  requireTestEvidence: true,
  trustedExecutionTool: undefined,
  secretPolicy: parseSecretPolicy('block'),
  journalDir: 'runs',
  connectors: { sentry: 'sentry', github: 'github', githubId: 'srv_1' },
});

describe('checkPerimeterConfig', () => {
  test('the documented default perimeter passes for cart-service', () => {
    const verdict = checkPerimeterConfig(
      config(['src/**', '!.github/**', '!package.json', '!package-lock.json']),
    );
    assert.match(verdict, /CI and manifests out of reach/);
  });

  test('a perimeter that grants the CI workflow fails', () => {
    assert.throws(
      () => checkPerimeterConfig(config(['.github/**', '!package.json'])),
      /could rewrite the CI that verifies its own patch/,
    );
  });

  test('a grant that admits the dependency manifests fails', () => {
    assert.throws(
      () => checkPerimeterConfig(config(['src/**', 'package.json'])),
      /package\.json/,
    );
  });

  test('an exclusions-only perimeter grants nothing and fails', () => {
    assert.throws(() => checkPerimeterConfig(config(['!.github/**'])), /grants nothing/);
  });
});

describe('connectorAuthVerdict', () => {
  const server = (
    name: string,
    status: 'authenticated' | 'auth_required' | 'not_required',
  ): TrueForgeApi.ConfiguredMcpServer => ({
    name,
    // The manifest is required by the type but not by the verdict logic.
    manifest: {
      name,
      type: 'remote',
      url: `https://${name}.example/mcp`,
      description: 'test connector',
    },
    authStatus: { status },
  });

  test('both connectors authenticated passes', () => {
    const verdict = connectorAuthVerdict(
      [server('github', 'authenticated'), server('sentry', 'authenticated')],
      ['github', 'sentry'],
    );
    assert.match(verdict, /github=authenticated/);
    assert.match(verdict, /sentry=authenticated/);
  });

  test('a connector that exists but is awaiting authorization fails', () => {
    assert.throws(
      () =>
        connectorAuthVerdict(
          [server('github', 'authenticated'), server('sentry', 'auth_required')],
          ['github', 'sentry'],
        ),
      /sentry requires authorization.*mcp\.auth_required/s,
    );
  });

  test('a missing connector fails by name', () => {
    assert.throws(
      () => connectorAuthVerdict([server('github', 'authenticated')], ['github', 'sentry']),
      /no connector named sentry/,
    );
  });

  test('not_required is acceptable - header auth that needs no interactive step', () => {
    const verdict = connectorAuthVerdict(
      [server('github', 'not_required'), server('sentry', 'authenticated')],
      ['github', 'sentry'],
    );
    assert.match(verdict, /github=not_required/);
  });
});
