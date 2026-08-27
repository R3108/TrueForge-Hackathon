/**
 * Dispatch one incident to the agent.
 *
 *   npm run dispatch -- PROJECT-4A2
 *   npm run dispatch -- "TypeError: cannot read length of undefined in cart.ts"
 *
 * Opens a session on the saved agent, streams the repair run, and stops for a
 * human before anything is written to the repository.
 */
import { loadConfig } from '../config.ts';
import { createClient } from '../client.ts';
import { AGENT_NAME } from '../agent/spec.ts';
import { runIncident } from '../runtime/run.ts';
import { banner, style } from '../runtime/render.ts';

async function main(): Promise<void> {
  const incident = process.argv.slice(2).join(' ').trim();
  if (!incident) {
    console.error(
      `\n${style.red('Usage:')} npm run dispatch -- <sentry-issue-id | description>\n`,
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const client = createClient(config);

  banner('LICENCE TO PATCH', `incident: ${incident}`);

  console.log(`  target repo      ${style.bold(config.targetRepo)}`);
  console.log(
    `  write perimeter  ${
      config.writePaths.length > 0
        ? style.green(config.writePaths.join(', '))
        : style.yellow('none declared - only the human gate applies')
    }`,
  );

  // Reference the saved agent by name. `Session.title` is server-owned - the
  // create and update endpoints both reject it - so the incident id travels in
  // the brief instead.
  const { data: session } = await client.sessions.create({
    agent: { name: AGENT_NAME },
  });

  console.log(style.dim(`session ${session.id}`));
  console.log(style.dim(`watch live: ${config.baseUrl}/sessions/${session.id}\n`));

  const brief = [
    `Production incident: ${incident}`,
    ``,
    `Repository under repair: ${config.targetRepo}`,
    `Base branch: ${config.baseBranch}`,
    ``,
    `Work your six standing orders in order. Reproduce the failure in the sandbox`,
    `with a failing test before you write a single line of fix. When you are ready`,
    `to write to the repository, state your case first - a human is watching and`,
    `will approve or deny each write.`,
  ].join('\n');

  const { turns } = await runIncident(client, session.id, brief, config.writePaths);

  console.log(`\n${style.green('Incident closed')} ${style.dim(`(${turns} turns)`)}`);
  console.log(style.dim(`Full trace: ${config.baseUrl}/sessions/${session.id}\n`));
}

main().catch((error: unknown) => {
  console.error(`\n${style.red('Dispatch failed:')} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
