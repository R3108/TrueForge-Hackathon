import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, HARNESS_REPO } from '../config.ts';

/**
 * The agent repairs a service in another repository. Pointing it at its own
 * harness would let it propose patches to the gate that governs it, so that is
 * refused at load rather than caught downstream.
 */

const REQUIRED = {
  LTP_TARGET_REPO: 'R3108/cart-service',
  LTP_MODEL: 'openai/gpt-5-6-terra',
  // Trusted test evidence is on by default; these satisfy its requirements.
  LTP_TARGETED_TEST_COMMAND: 'npm test -- --test-name-pattern cart',
  LTP_FULL_SUITE_COMMAND: 'npm test',
  LTP_EXECUTION_TOOL_ID: 'test-execution-tool-id',
  LTP_EXECUTION_TOOL_NAME: 'test-execution-tool-name',
  // The gate binds GitHub policy to a stable connector server id.
  LTP_CONNECTOR_GITHUB_ID: 'test-github-server-id',
};

describe('loadConfig', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    for (const [key, value] of Object.entries(REQUIRED)) process.env[key] = value;
  });

  afterEach(() => {
    process.env = saved;
  });

  test('accepts a target that is not the harness', () => {
    assert.equal(loadConfig().targetRepo, 'R3108/cart-service');
  });

  test('refuses to target the harness repository', () => {
    process.env.LTP_TARGET_REPO = HARNESS_REPO;

    assert.throws(
      () => loadConfig(),
      /own harness/i,
      'an agent that can patch its own approval gate is not gated',
    );
  });

  test('refuses regardless of casing', () => {
    process.env.LTP_TARGET_REPO = HARNESS_REPO.toUpperCase();
    assert.throws(() => loadConfig(), /own harness/i);
  });

  test('still rejects a malformed repository name', () => {
    process.env.LTP_TARGET_REPO = 'not-a-repo';
    assert.throws(() => loadConfig(), /owner\/repo/);
  });

  test('parses the write perimeter into patterns', () => {
    process.env.LTP_WRITE_PATHS = 'src/**, !.github/** , !package.json';

    assert.deepEqual(loadConfig().writePaths, ['src/**', '!.github/**', '!package.json']);
  });
});
