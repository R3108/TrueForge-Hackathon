/**
 * Dispatch one incident to the agent.
 *
 *   npm run dispatch -- PROJECT-4A2
 *   npm run dispatch -- "TypeError: cannot read length of undefined in cart.ts"
 *   npm run dispatch -- --rehearse PROJECT-4A2     # full run, every write refused
 *
 * Opens a session on the saved agent, streams the repair run, and stops for a
 * human before anything is written to the repository. Every decision - yours or
 * the perimeter's - is appended to a tamper-evident journal under `runs/`.
 */
import { loadConfig } from '../config.ts';
import { createClient } from '../client.ts';
import { AGENT_NAME } from '../agent/spec.ts';
import { runIncident } from '../runtime/run.ts';
import { banner, style, table } from '../runtime/render.ts';
import { Journal } from '../runtime/journal.ts';
import { exitWhenFlushed } from './exit.ts';

interface Flags {
  incident: string;
  rehearse: boolean;
  journal: boolean;
}

function parseArgs(argv: string[]): Flags {
  const words: string[] = [];
  let rehearse = false;
  let journal = true;

  for (const arg of argv) {
    if (arg === '--rehearse' || arg === '--dry-run') rehearse = true;
    else if (arg === '--no-journal') journal = false;
    else words.push(arg);
  }

  return { incident: words.join(' ').trim(), rehearse, journal };
}

async function main(): Promise<void> {
  const { incident, rehearse, journal: keepJournal } = parseArgs(process.argv.slice(2));
  if (!incident) {
    console.error(
      `\n${style.red('Usage:')} npm run dispatch -- [--rehearse] [--no-journal] <sentry-issue-id | description>\n`,
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const client = createClient(config);

  banner('LICENCE TO PATCH', `incident: ${incident}`);

  console.log(`  target repo      ${style.bold(config.targetRepo)}`);
  console.log(
    `  write perimeter  ${style.green(config.writePaths.join(', '))}`,
  );
  console.log(
    `  secret tripwire  ${
      config.secretPolicy === 'block'
        ? style.green('block')
        : style.yellow(`${config.secretPolicy} - credentials will not be refused automatically`)
    }`,
  );
  if (rehearse) {
    console.log(`  mode             ${style.blue('rehearsal - every repository write is refused')}`);
  }

  // Reference the saved agent by name. `Session.title` is server-owned - the
  // create and update endpoints both reject it - so the incident id travels in
  // the brief instead.
  const { data: session } = await client.sessions.create({
    agent: { name: AGENT_NAME },
  });

  console.log(style.dim(`session ${session.id}`));
  console.log(style.dim(`watch live: ${config.baseUrl}/sessions/${session.id}\n`));

  const journal = new Journal({
    sessionId: session.id,
    incident,
    ...(keepJournal ? { dir: config.journalDir } : {}),
  });

  const brief = [
    `Production incident: ${incident}`,
    ``,
    `Repository under repair: ${config.targetRepo}`,
    `Base branch: ${config.baseBranch}`,
    ...(config.writePaths.length > 0
      ? [
          ``,
          `Write perimeter: you may only write to paths matching ${config.writePaths.join(', ')}.`,
          `A write outside it is refused automatically, without a human being asked - so if the`,
          `fix genuinely belongs elsewhere, say so and stop rather than trying to route around it.`,
        ]
      : []),
    ``,
    `Work your six standing orders in order. Reproduce the failure in the sandbox`,
    `with a failing test before you write a single line of fix. When you are ready`,
    `to write to the repository, state your case first - a human is watching and`,
    `will approve or deny each write.`,
    ...(rehearse
      ? [
          ``,
          `This is a REHEARSAL run: every repository write will be refused by policy. Work the`,
          `incident to the end anyway and report exactly what you would have pushed.`,
        ]
      : []),
  ].join('\n');

  const { turns } = await runIncident(client, session.id, brief, {
    targetRepo: config.targetRepo,
    baseBranch: config.baseBranch,
    writePaths: config.writePaths,
    githubConnector: config.connectors.github,
    githubConnectorId: config.connectors.githubId,
    policyVersion: config.policyVersion,
    requireTestEvidence: config.requireTestEvidence,
    trustedExecutionTool: config.trustedExecutionTool,
    targetedCommand: config.targetedTestCommand,
    fullSuiteCommand: config.fullSuiteCommand,
    secretPolicy: config.secretPolicy,
    rehearse,
    journal,
  });

  console.log(`\n${style.green('Incident closed')} ${style.dim(`(${turns} turns, verified terminal status)`)}`);
  reportDecisions(journal);
  console.log(style.dim(`Full trace: ${config.baseUrl}/sessions/${session.id}\n`));
}

/**
 * The last thing on screen should be what was decided, not what was said. A run
 * with no gated calls at all is itself worth stating - it means the agent never
 * reached the repository.
 */
function reportDecisions(journal: Journal): void {
  const entries = journal.entries();
  if (entries.length === 0) {
    console.log(style.dim('No repository writes were requested.'));
    return;
  }

  console.log('');
  console.log(
    table(
      ['#', 'TOOL', 'PATHS', 'OUTCOME'],
      entries.map((entry) => [
        String(entry.seq),
        entry.tool,
        entry.paths.join(', ') || '—',
        entry.outcome === 'approved' ? style.green(entry.outcome) : style.red(entry.outcome),
      ]),
    ),
  );

  console.log(
    `\n  ${journal
      .tally()
      .map(([outcome, count]) => `${count} ${outcome}`)
      .join(' · ')}`,
  );
  console.log(style.dim(`  audit digest  sha256:${journal.digest()}`));

  if (journal.file) {
    const report = journal.writeReport();
    console.log(style.dim(`  journal       ${journal.file}`));
    if (report) console.log(style.dim(`  report        ${report}`));
    console.log(style.dim(`  verify        npm run journal -- ${journal.file}`));
  }
  console.log('');
}

main()
  .catch((error: unknown) => {
    console.error(
      `\n${style.red('Dispatch failed:')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  // The incident is closed and the journal is written; the SDK's request timers
  // are not this process's problem any more.
  .finally(exitWhenFlushed);
