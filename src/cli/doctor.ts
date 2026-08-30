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
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../config.ts';
import { createClient } from '../client.ts';
import { AGENT_NAME, GITHUB_WRITE_TOOLS } from '../agent/spec.ts';
import { compilePerimeter, judgePath } from '../runtime/perimeter.ts';
import { banner, style } from '../runtime/render.ts';
import { exitWhenFlushed } from './exit.ts';

/** Run the pre-flight only when executed as a script, not when imported by tests. */
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
})();

/**
 * Paths, inside the TARGET repository, that the agent must not own even though
 * a broad `src/**` grant would hand them over: the CI that verifies its own
 * patch, and the dependency manifests. Harness isolation is enforced earlier -
 * `loadConfig` refuses a target that IS the harness - so this check assesses the
 * configured target on its own terms instead of unconditionally treating this
 * repository's `src/**` as reachable.
 */
const TARGET_SENSITIVE_PATHS = [
  '.github/workflows/ci.yml',
  'package.json',
  'package-lock.json',
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
    {
      label: 'Connectors authorized',
      run: () => checkConnectorAuth(client, config),
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

  // The runtime gate binds GitHub policy to the connector's stable server id,
  // which the agent manifest does not carry. A stale LTP_CONNECTOR_GITHUB_ID
  // means every write is denied as untrusted_tool_origin with the gate otherwise
  // green, so the check at least names the symptom instead of staying silent.
  console.log(
    `  ${style.yellow('NOTE')} LTP_CONNECTOR_GITHUB_ID (${config.connectors.githubId}) is verified at ` +
      `dispatch: if every GitHub write is denied as untrusted_tool_origin, re-run a turn and ` +
      `copy the fresh toolInfo serverId from the stream.`,
  );

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
 * is a choice; one that grants nothing, or that hands the agent the CI that
 * verifies its own patch or the dependency manifests of the service it repairs,
 * is a mistake worth catching before an incident rather than during one.
 */
export function checkPerimeterConfig(config: Config): string {
  if (config.writePaths.length === 0) {
    throw new Advisory('no perimeter declared (LTP_WRITE_PATHS empty) - only the human gate applies');
  }

  const rules = compilePerimeter(config.writePaths);
  if (rules.allow.length === 0) {
    throw new Error(
      'the perimeter is exclusions only, so it grants nothing and every write will be refused',
    );
  }

  const admitted = TARGET_SENSITIVE_PATHS.filter(
    (path) => judgePath(path, rules).status === 'inside',
  );
  if (admitted.length > 0) {
    throw new Error(
      `the perimeter hands the agent ${admitted.join(', ')} inside ${config.targetRepo} - ` +
        `it could rewrite the CI that verifies its own patch or the dependency manifests`,
    );
  }

  return `${rules.allow.length} grant(s), ${rules.deny.length} exclusion(s); CI and manifests out of reach in ${config.targetRepo}`;
}

/**
 * A connector entry in the agent manifest proves the connector is *attached*,
 * not that it is *authorized*. The worst time to learn the GitHub header token
 * has expired is when dispatch dies with `mcp.auth_required` on camera, so this
 * asks the server's settings projection - which carries a nested `auth_status`
 * per server - for the real state of both configured connectors, and then does
 * one live `tools/list` round-trip through the GitHub connector, which is what
 * actually exercises the stored credential.
 *
 * The runtime gate additionally binds policy to the connector's *stable server
 * id* (LTP_CONNECTOR_GITHUB_ID). The settings projection exposes names and auth
 * state but not that id, so doctor cannot prove the configured value is current
 * from here - it says so, with the symptom a stale id produces, rather than
 * print a green line over an unverified identity.
 */
async function checkConnectorAuth(client: TrueForge, config: Config): Promise<string> {
  let servers: TrueForgeApi.ConfiguredMcpServer[];
  try {
    ({ data: servers } = await client.settings.mcpServers.list());
  } catch (error) {
    // The settings projection is admin-scoped; a non-admin operator cannot
    // verify connector auth from here. Say so rather than print "All clear"
    // over an unverified claim - but a check we cannot run is a warning, not a
    // failure, when the server itself refused it.
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) {
      throw new Advisory(
        `cannot verify connector authorization (${status} from the settings projection) - ` +
          `confirm both connectors show as connected in Settings → Connectors before recording`,
      );
    }
    throw error;
  }

  const verdict = connectorAuthVerdict(servers, [
    config.connectors.github,
    config.connectors.sentry,
  ]);

  // A live tools/list through the GitHub connector: the settings projection
  // says what the server *believes* about the credential; this uses it. A
  // revoked or wrong header token fails here, before an incident depends on it.
  const { data: githubTools } = await client.mcpServers.listTools(config.connectors.github);
  if (!Array.isArray(githubTools) || githubTools.length === 0) {
    throw new Error(
      `the "${config.connectors.github}" connector returned no tools from a live tools/list - ` +
        `its credential may be invalid even though the settings projection reports it authorized`,
    );
  }

  return `${verdict}; ${githubTools.length} GitHub tools live`;
}

/**
 * The verdict on its own, so the logic is testable without a server: both
 * connectors must exist and none may still be awaiting authorization.
 */
export function connectorAuthVerdict(
  servers: TrueForgeApi.ConfiguredMcpServer[],
  expected: string[],
): string {
  const missing = expected.filter(
    (name) => !servers.some((server) => server.name === name),
  );
  if (missing.length > 0) {
    throw new Error(
      `no connector named ${missing.join(' or ')} on the server - add it in Settings → Connectors`,
    );
  }

  const unauthorized = servers.filter(
    (server) =>
      expected.includes(server.name) && server.authStatus.status === 'auth_required',
  );
  if (unauthorized.length > 0) {
    const first = unauthorized[0];
    throw new Error(
      `connector ${unauthorized.map((server) => server.name).join(' and ')} requires authorization` +
        (first?.authStatus.authorizationUrl ? ` (${first.authStatus.authorizationUrl})` : '') +
        ` - reconnect it in Settings → Connectors before dispatch, or the run will fail with mcp.auth_required`,
    );
  }

  return expected
    .map((name) => {
      const server = servers.find((candidate) => candidate.name === name);
      return `${name}=${server?.authStatus.status}`;
    })
    .join(', ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isMain) {
  main()
    .catch((error: unknown) => {
      console.error(`\n${style.red('Doctor crashed:')} ${describe(error)}\n`);
      process.exitCode = 1;
    })
    // A pre-flight against a server that is down leaves a dead connection and an
    // SDK timer on the loop; without this the command sits there long after it
    // has told you what is wrong.
    .finally(exitWhenFlushed);
}
