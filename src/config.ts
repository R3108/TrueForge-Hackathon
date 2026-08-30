/**
 * Environment configuration.
 *
 * Nothing secret is ever read into the agent spec: model-provider API keys and
 * GitHub/Sentry credentials live inside TrueForge connectors on the server, so
 * this file only carries names and URLs.
 */

import { parseSecretPolicy, type SecretPolicy } from './runtime/secrets.ts';

export interface Config {
  baseUrl: string;
  /** Only set when the TrueForge server runs with OIDC login enabled. */
  token: string | undefined;
  model: string;
  targetRepo: string;
  baseBranch: string;
  /**
   * Glob allowlist of paths the agent may write to inside `targetRepo`.
   * A `!` prefix excludes, and exclusions win. Empty means no perimeter is
   * declared, and only the human gate applies.
   */
  writePaths: string[];
  /** Version bound into every approval fingerprint. */
  policyVersion: string;
  /** Structured test commands recognized by the evidence ledger. */
  targetedTestCommand: string | undefined;
  fullSuiteCommand: string | undefined;
  requireTestEvidence: boolean;
  /** Exact host-owned producer allowed to emit structured execution facts. */
  trustedExecutionTool:
    | {
        toolSetId: string;
        toolSetName: string;
        toolType: 'truefoundry-system';
      }
    | undefined;
  /** What to do when a payload bound for the repository carries a credential. */
  secretPolicy: SecretPolicy;
  /** Where decision journals are written. `--no-journal` skips writing one. */
  journalDir: string;
  connectors: {
    sentry: string;
    github: string;
    /** Stable SDK MCP server id paired with the configured GitHub name. */
    githubId: string;
  };
}

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
  );
}

/**
 * This repository - the agent's own harness.
 *
 * The gate, the perimeter, the tripwire and the journal all live here. An agent
 * pointed at this repo could propose a patch to any of them, and the operator
 * approving it would be reading a diff produced by the thing the diff disarms.
 * The perimeter would still refuse it, but that puts the whole safety argument
 * on one glob matcher being right.
 *
 * So the target is a *different* repository, and that is enforced here rather
 * than left to a comment in `.env.example`. There is deliberately no override:
 * a flag to disable this would be the first thing anyone reached for.
 */
export const HARNESS_REPO = 'R3108/TrueForge-Hackathon';

export function loadConfig(): Config {
  const targetRepo = env('LTP_TARGET_REPO');
  if (!/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) {
    throw new Error(`LTP_TARGET_REPO must look like "owner/repo", got "${targetRepo}".`);
  }

  if (targetRepo.toLowerCase() === HARNESS_REPO.toLowerCase()) {
    throw new Error(
      `LTP_TARGET_REPO is set to ${targetRepo}, which is the agent's own harness. ` +
        `Point it at the service the agent repairs (for example R3108/cart-service) ` +
        `so that the approval gate is not something the agent can propose changes to.`,
    );
  }

  const requireTestEvidence = env('LTP_REQUIRE_TEST_EVIDENCE', 'true').toLowerCase() !== 'false';
  const targetedTestCommand = process.env.LTP_TARGETED_TEST_COMMAND?.trim() || undefined;
  const fullSuiteCommand = process.env.LTP_FULL_SUITE_COMMAND?.trim() || undefined;
  const executionToolId = process.env.LTP_EXECUTION_TOOL_ID?.trim();
  const executionToolName = process.env.LTP_EXECUTION_TOOL_NAME?.trim();
  if ((executionToolId && !executionToolName) || (!executionToolId && executionToolName)) {
    throw new Error(
      'LTP_EXECUTION_TOOL_ID and LTP_EXECUTION_TOOL_NAME must be configured together.',
    );
  }
  if (requireTestEvidence && (!targetedTestCommand || !fullSuiteCommand)) {
    throw new Error(
      'Trusted test evidence requires LTP_TARGETED_TEST_COMMAND and LTP_FULL_SUITE_COMMAND.',
    );
  }
  if (requireTestEvidence && (!executionToolId || !executionToolName)) {
    throw new Error(
      'Trusted test evidence requires LTP_EXECUTION_TOOL_ID and LTP_EXECUTION_TOOL_NAME.',
    );
  }

  return {
    baseUrl: env('TRUEFORGE_BASE_URL', 'http://localhost:8790'),
    token: process.env.TRUEFORGE_TOKEN?.trim() || undefined,
    model: env('LTP_MODEL', 'openai/gpt-5-6-terra'),
    targetRepo,
    baseBranch: env('LTP_BASE_BRANCH', 'main'),
    writePaths: (process.env.LTP_WRITE_PATHS ?? '')
      .split(',')
      .map((pattern) => pattern.trim())
      .filter(Boolean),
    policyVersion: env('LTP_POLICY_VERSION', 'ltp-firewall-v1'),
    targetedTestCommand,
    fullSuiteCommand,
    requireTestEvidence,
    trustedExecutionTool:
      executionToolId && executionToolName
        ? {
            toolSetId: executionToolId,
            toolSetName: executionToolName,
            toolType: 'truefoundry-system',
          }
        : undefined,
    secretPolicy: parseSecretPolicy(process.env.LTP_SECRET_POLICY),
    journalDir: env('LTP_JOURNAL_DIR', 'runs'),
    connectors: {
      sentry: env('LTP_CONNECTOR_SENTRY', 'sentry'),
      github: env('LTP_CONNECTOR_GITHUB', 'github'),
      githubId: env('LTP_CONNECTOR_GITHUB_ID'),
    },
  };
}
