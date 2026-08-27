/**
 * Pre-flight check. Run this before a demo so you find out the connector is
 * unauthorized now, and not on camera.
 *
 *   npm run doctor
 *
 * Two of these checks are about the agent's restraints rather than its plumbing.
 * A gate is a claim, and a claim that nothing verifies decays: someone edits the
 * agent in the TrueForge UI, or widens a glob to unstick a demo, and the repo
 * still says the boundary is there. `doctor` compares what the server actually
 * has against what this repository declares, and refuses to call that green.
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { loadConfig, type Config } from '../config.ts';
import { createClient } from '../client.ts';
import { AGENT_NAME, GITHUB_WRITE_TOOLS } from '../agent/spec.ts';
import { compilePerimeter, judgePath } from '../runtime/perimeter.ts';
import { banner, style } from '../runtime/render.ts';
import { exitWhenFlushed } from './exit.ts';

/**
 * Files that decide what the agent may do. If the write perimeter admits any of
 * them, the agent can propose a pull request that removes its own restraints -
 * and a 3am approval prompt for "one small config change" is exactly how that
 * gets merged.
 */
const CONTROL_PLANE = [
  'src/agent/spec.ts',
  'src/runtime/approvals.ts',
  'src/runtime/perimeter.ts',
  'src/runtime/secrets.ts',
  'src/config.ts',
  'package.json',
  '.github/workflows/ci.yml',
];

interface Check {
  label: string;
  run: () => Promise<string>;
}

/** A finding worth saying out loud that should not fail the pre-flight. */
class Advisory extends Error {}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`\n${style.red('Config error:')} ${describe(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const client = createClient(config);
  banner('LICENCE TO PATCH — pre-flight', config.baseUrl);

  const checks: Check[] = [
    {
      label: 'Node 22.14+',
      run: async () => {
        const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
        if (major > 22 || (major === 22 && minor >= 14)) return process.versions.node;
        throw new Error(`found ${process.versions.node}; TrueForge needs 22.14 or newer`);
      },
    },
    {
      label: 'TrueForge server reachable',
      run: async () => {
        const res = await fetch(`${config.baseUrl}/api/v1/docs`, { redirect: 'manual' });
        if (res.status >= 500) throw new Error(`server returned ${res.status}`);
        return `${config.baseUrl} responded`;
      },
    },
    {
      label: `Agent "${AGENT_NAME}" provisioned`,
      run: async () => {
        await savedAgent(client);
        return 'found';
      },
    },
    {
      label: 'Server gate matches the repo spec',
      run: () => checkGateDrift(client, config),
    },
    {
      label: 'Write perimeter holds',
      run: async () => checkPerimeterConfig(config),
    },
  ];

  let failed = 0;
  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  ${style.green('PASS')}  ${check.label} ${style.dim(detail)}`);
    } catch (error) {
      if (error instanceof Advisory) {
        console.log(`  ${style.yellow('WARN')}  ${check.label} ${style.dim(error.message)}`);
        continue;
      }
      failed++;
      console.log(`  ${style.red('FAIL')}  ${check.label} ${style.dim(describe(error))}`);
    }
  }

  console.log(
    `\n${failed === 0 ? style.green('All clear. Cleared for dispatch.') : style.red(`${failed} check(s) failed.`)}\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

/** One `agents.list()` per run, shared by the checks that need the manifest. */
let cached: Promise<TrueForgeApi.Agent> | undefined;
function savedAgent(client: TrueForge): Promise<TrueForgeApi.Agent> {
  cached ??= client.agents.list().then(({ data }) => {
    const agent = data.find((candidate) => candidate.name === AGENT_NAME);
    if (!agent) throw new Error('not found - run: npm run provision');
    return agent;
  });
  return cached;
}

/**
 * Does the agent on the server still gate everything this repository says it
 * gates? A spec that only exists in git is documentation, not a control.
 */
async function checkGateDrift(client: TrueForge, config: Config): Promise<string> {
  const agent = await savedAgent(client).catch(() => undefined);
  if (!agent) throw new Advisory('agent not provisioned yet - nothing to compare');

  const servers = agent.manifest.mcpServers ?? [];
  const github = servers.find((server) => server.name === config.connectors.github);
  if (!github) {
    throw new Error(`the saved agent has no "${config.connectors.github}" connector attached`);
  }

  const gate = github.requireApprovalForTools ?? [];
  const sentry = servers.find((server) => server.name === config.connectors.sentry);
  const sentryReadOnly = (sentry?.enableTools ?? []).includes('@read-only');

  if (!sentry) {
    throw new Error(
      `the saved agent has no "${config.connectors.sentry}" connector attached - run: npm run provision`,
    );
  }

  // Not an advisory. The repository states that incidents are read and never
  // mutated; if the live agent can write to Sentry, that statement is false and
  // "All clear" would be the wrong thing to print.
  if (!sentryReadOnly) {
    throw new Error(
      `the saved agent's "${config.connectors.sentry}" connector is not restricted to @read-only ` +
        `(currently: ${(sentry.enableTools ?? ['@all']).join(', ')}) - run: npm run provision to restore it`,
    );
  }

  if (gate.includes('@all')) return 'every tool gated (@all)';

  const missing = GITHUB_WRITE_TOOLS.filter((tool) => !gate.includes(tool));
  if (missing.length === 0) return `${GITHUB_WRITE_TOOLS.length} write tools gated`;

  if (gate.some((selector) => selector === '@write' || selector === '@destructive')) {
    throw new Advisory(
      `gated by category (${gate.join(', ')}); per-tool coverage cannot be verified from here`,
    );
  }

  throw new Error(
    `the saved agent no longer gates ${missing.join(', ')} - run: npm run provision to restore it`,
  );
}

/**
 * Is the declared perimeter one that actually restrains the agent? An empty one
 * is a choice; one that grants nothing, or that admits the files defining the
 * gate, is a mistake worth catching before an incident rather than during one.
 */
function checkPerimeterConfig(config: Config): string {
  if (config.writePaths.length === 0) {
    throw new Advisory('no perimeter declared (LTP_WRITE_PATHS empty) - only the human gate applies');
  }

  const rules = compilePerimeter(config.writePaths);
  if (rules.allow.length === 0) {
    throw new Error(
      'the perimeter is exclusions only, so it grants nothing and every write will be refused',
    );
  }

  const admitted = CONTROL_PLANE.filter((path) => judgePath(path, rules).status === 'inside');
  if (admitted.length > 0) {
    throw new Error(
      `the perimeter admits the agent's own control plane (${admitted.join(', ')}) - it could patch its own gate`,
    );
  }

  return `${rules.allow.length} grant(s), ${rules.deny.length} exclusion(s); control plane out of reach`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main()
  .catch((error: unknown) => {
    console.error(`\n${style.red('Doctor crashed:')} ${describe(error)}\n`);
    process.exitCode = 1;
  })
  // A pre-flight against a server that is down leaves a dead connection and an
  // SDK timer on the loop; without this the command sits there long after it
  // has told you what is wrong.
  .finally(exitWhenFlushed);
