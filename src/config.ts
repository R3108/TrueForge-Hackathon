/**
 * Environment configuration.
 *
 * Nothing secret is ever read into the agent spec: model-provider API keys and
 * GitHub/Sentry credentials live inside TrueForge connectors on the server, so
 * this file only carries names and URLs.
 */

export interface Config {
  baseUrl: string;
  /** Only set when the TrueForge server runs with OIDC login enabled. */
  token: string | undefined;
  model: string;
  targetRepo: string;
  baseBranch: string;
  /**
   * Glob allowlist of paths the agent may write to inside `targetRepo`.
   * At least one pattern is required; an undeclared perimeter fails startup.
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

export function loadConfig(): Config {
  const targetRepo = env('LTP_TARGET_REPO');
  if (!/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) {
    throw new Error(`LTP_TARGET_REPO must look like "owner/repo", got "${targetRepo}".`);
  }

  const writePaths = (process.env.LTP_WRITE_PATHS ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (writePaths.length === 0) {
    throw new Error('LTP_WRITE_PATHS must declare at least one repository path glob.');
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
    writePaths,
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
    connectors: {
      sentry: env('LTP_CONNECTOR_SENTRY', 'sentry'),
      github: env('LTP_CONNECTOR_GITHUB', 'github'),
      githubId: env('LTP_CONNECTOR_GITHUB_ID'),
    },
  };
}
