/**
 * Create or update the `licence-to-patch` agent on the TrueForge server from
 * the spec in this repository.
 *
 * The point of this script is reproducibility: the agent a judge runs is the
 * agent in `src/agent/spec.ts`, not something hand-clicked in a UI and lost.
 */
import { loadConfig } from '../config.ts';
import { createClient } from '../client.ts';
import { AGENT_NAME, buildAgentSpec, GITHUB_WRITE_TOOLS } from '../agent/spec.ts';
import { findAgentId } from '../agent/registry.ts';
import { banner, style } from '../runtime/render.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);
  const spec = buildAgentSpec(config);

  banner('LICENCE TO PATCH — provision', `${config.baseUrl} · ${config.model}`);

  console.log(`  target repo   ${style.bold(config.targetRepo)} (base: ${config.baseBranch})`);
  console.log(`  connectors    ${config.connectors.sentry}, ${config.connectors.github}`);
  console.log(`  sandbox       ${style.green('enabled')}`);
  console.log(
    `  approval gate ${style.yellow(`${GITHUB_WRITE_TOOLS.length} repository-writing tools`)}\n`,
  );

  const existingId = await findAgentId(client, AGENT_NAME);

  if (existingId) {
    // `name` is immutable server-side, so an update replaces the manifest only.
    const { data } = await client.agents.update(existingId, { manifest: spec });
    console.log(`${style.green('Updated')} agent ${style.bold(AGENT_NAME)} (${data.id})`);
  } else {
    const { data } = await client.agents.create({ name: AGENT_NAME, manifest: spec });
    console.log(`${style.green('Created')} agent ${style.bold(AGENT_NAME)} (${data.id})`);
  }

  console.log(
    `\n${style.dim('Next:')} npm run dispatch -- <sentry-issue-id>   ${style.dim('(or open the TrueForge chat UI)')}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(`\n${style.red('Provisioning failed:')} ${describe(error)}\n`);
  process.exitCode = 1;
});

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
