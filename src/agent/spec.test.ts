import assert from 'node:assert/strict';
import test from 'node:test';

import type { Config } from '../config.ts';
import { buildAgentSpec } from './spec.ts';

const config: Config = {
  baseUrl: 'http://localhost:8790',
  token: undefined,
  model: 'tokenrouter/glm-5-3',
  targetRepo: 'R3108/cart-service',
  baseBranch: 'main',
  writePaths: ['src/**'],
  policyVersion: 'ltp-firewall-v1',
  targetedTestCommand: 'npm test',
  fullSuiteCommand: 'npm test',
  requireTestEvidence: true,
  trustedExecutionTool: {
    toolSetId: 'sandbox-tool-set',
    toolSetName: 'sandbox-tool-set',
    toolType: 'truefoundry-system',
  },
  secretPolicy: 'block',
  journalDir: 'runs',
  connectors: {
    sentry: 'sentry',
    github: 'github',
    githubId: 'github-server-id',
  },
};

test('buildAgentSpec uses the current TrueForge compaction trigger schema', () => {
  const spec = buildAgentSpec(config);

  assert.deepEqual(spec.config?.contextManagement?.compaction, {
    enabled: true,
    trigger: { type: 'input_tokens', value: 120_000 },
  });
});
