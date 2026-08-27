/**
 * Verify and print a decision journal.
 *
 *   npm run journal -- runs/<session-id>.jsonl
 *
 * Every record carries the hash of the record before it, so this recomputes the
 * chain end to end. If a line was edited or removed after the run, it says which
 * one and stops. The digest it prints is the same string the run printed when it
 * finished - matching them is the whole point.
 */
import { readJournal, verifyChain, type JournalEntry } from '../runtime/journal.ts';
import { banner, style, table, relativeTime } from '../runtime/render.ts';

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error(`\n${style.red('Usage:')} npm run journal -- <path-to-journal.jsonl>\n`);
    process.exitCode = 1;
    return;
  }

  let entries: JournalEntry[];
  try {
    entries = readJournal(file);
  } catch (error) {
    console.error(
      `\n${style.red('Could not read the journal:')} ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    // A journal that will not parse is a failed verification, not a missing
    // feature: JSONL is append-only by construction, so a broken line means
    // something wrote to the file that was not this tool.
    process.exitCode = 1;
    return;
  }

  const first = entries[0];
  banner('DECISION JOURNAL', first ? `incident ${first.incident} · session ${first.sessionId}` : file);

  if (entries.length === 0) {
    console.log(style.dim('  Empty journal: no repository write was ever requested.\n'));
    return;
  }

  console.log(
    table(
      ['#', 'WHEN', 'TOOL', 'PATHS', 'OUTCOME', 'OPERATOR'],
      entries.map((entry) => [
        String(entry.seq),
        relativeTime(entry.ts),
        entry.tool,
        entry.paths.join(', ') || '—',
        entry.outcome === 'approved' ? style.green(entry.outcome) : style.red(entry.outcome),
        entry.operator,
      ]),
    ),
  );

  const result = verifyChain(entries);
  console.log('');

  if (result.ok) {
    console.log(`  ${style.green('CHAIN VERIFIED')} ${style.dim(`${result.entries} record(s)`)}`);
    console.log(style.dim(`  digest  sha256:${entries.at(-1)?.hash}`));
    console.log(
      style.dim(
        '  This proves the file is intact, not who ran it. It is a local audit trail, not a signed one.\n',
      ),
    );
    return;
  }

  console.log(`  ${style.red('CHAIN BROKEN')} at record ${result.brokenAt} of ${result.entries}`);
  console.log(style.red(`  ${result.problem}\n`));
  process.exitCode = 1;
}

main();
