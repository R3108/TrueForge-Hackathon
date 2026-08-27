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
  /** What to do when a payload bound for the repository carries a credential. */
  secretPolicy: SecretPolicy;
  /** Where decision journals are written. `--no-journal` skips writing one. */
  journalDir: string;
  connectors: {
    sentry: string;
    github: string;
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
    secretPolicy: parseSecretPolicy(process.env.LTP_SECRET_POLICY),
    journalDir: env('LTP_JOURNAL_DIR', 'runs'),
    connectors: {
      sentry: env('LTP_CONNECTOR_SENTRY', 'sentry'),
      github: env('LTP_CONNECTOR_GITHUB', 'github'),
    },
  };
}
