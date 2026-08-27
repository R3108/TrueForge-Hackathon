import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import {
  style,
  preview,
  summarizeCall,
  renderFields,
  numberLines,
  pathsIn,
  payloadsIn,
} from './render.ts';
import { checkPerimeter, describeOffender, type Offender } from './perimeter.ts';
import { scanPayloads, describeFinding, type SecretPolicy, type SecretFinding } from './secrets.ts';
import type { Journal, Outcome } from './journal.ts';

/**
 * A tool call the harness has paused, resolved against the event index so we
 * can show the operator what they are actually approving.
 */
export interface PendingCall {
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ClearanceOptions {
  /** Globs the agent may write to. Empty means only the human gate applies. */
  writePaths?: string[];
  /** What to do about a credential in a payload. Default: block. */
  secretPolicy?: SecretPolicy;
  /** Refuse every write without asking - a full run with nothing at stake. */
  rehearse?: boolean;
  /** Append-only record of what was decided. */
  journal?: Journal;
}

/**
 * Aliased to the SDK's own type rather than re-declared: this is the payload the
 * approval gate sends back, and a silent key mismatch here would be a safety
 * bug, not a cosmetic one.
 */
export type Decision = TrueForgeApi.UserToolApprovalEvent;

/** A call that survived the automatic checks and needs a person. */
interface Reviewable {
  call: PendingCall;
  /** Credentials found under a `warn` policy - shown, not enforced. */
  warnings: Array<SecretFinding & { where: string }>;
}

/**
 * Ask a human before the agent writes to the repository.
 *
 * This is deliberately a blocking, explicit prompt: the whole safety argument of
 * this project is that the agent cannot mutate a repo while nobody is looking.
 * A non-TTY session (CI, piped input) denies by default rather than silently
 * auto-approving - failing closed is the only safe direction here, and so is
 * treating a Ctrl-C at the prompt as a "no" rather than an unanswered question.
 *
 * Two classes of write never reach the prompt at all: those outside the declared
 * perimeter, and those carrying something that looks like a credential. An
 * operator cannot approve what they are never shown, which is the point - a
 * boundary should not be something a tired human can be walked through.
 */
export async function requestClearance(
  pending: PendingCall[],
  options: ClearanceOptions = {},
): Promise<Decision[]> {
  if (pending.length === 0) return [];

  const { writePaths = [], secretPolicy = 'block', rehearse = false, journal } = options;

  const decisions: Decision[] = [];
  const reviewable: Reviewable[] = [];

  const settle = (call: PendingCall, outcome: Outcome, reason: string): void => {
    decisions.push({
      type: 'user.tool_approval',
      threadId: call.threadId,
      toolCallId: call.toolCallId,
      approval: { status: 'deny', reason },
    });
    journal?.record({
      tool: call.toolName,
      threadId: call.threadId,
      toolCallId: call.toolCallId,
      paths: pathsIn((call.args ?? {}) as Record<string, unknown>),
      outcome,
      reason,
    });
  };

  for (const call of pending) {
    const verdict = checkPerimeter(call.args, writePaths);
    if (verdict.status === 'blocked') {
      settle(
        call,
        'blocked-perimeter',
        `Refused by the write perimeter. ${call.toolName} would write to ${verdict.offending
          .map(describeOffender)
          .join(', ')}, which is outside the declared perimeter (${writePaths.join(
          ', ',
        )}). No human was asked.`,
      );
      renderBlocked(call, verdict.offending, writePaths);
      continue;
    }

    const findings =
      secretPolicy === 'off'
        ? []
        : scanPayloads(payloadsIn((call.args ?? {}) as Record<string, unknown>));

    if (findings.length > 0 && secretPolicy === 'block') {
      settle(
        call,
        'blocked-secret',
        `Refused by the credential tripwire. The payload of ${call.toolName} contains ${findings
          .map((finding) => `${finding.label} (${finding.where}:${finding.line})`)
          .join(', ')}. Remove the credential and read it from the environment instead. No human was asked.`,
      );
      renderTripwire(call, findings);
      continue;
    }

    reviewable.push({ call, warnings: findings });
  }

  if (reviewable.length === 0) return decisions;

  if (rehearse) {
    console.log(`\n${style.blue('━'.repeat(64))}`);
    console.log(style.blue(style.bold('  REHEARSAL')));
    console.log(
      style.dim(
        `  ${reviewable.length} write(s) would have been offered for approval. Refusing all.`,
      ),
    );
    console.log(`${style.blue('━'.repeat(64))}\n`);

    for (const { call } of reviewable) {
      renderCall(0, 0, call, []);
      settle(
        call,
        'denied-rehearsal',
        'Rehearsal run (--rehearse): repository writes are refused by policy. Continue as if this were denied by the operator.',
      );
    }
    return decisions;
  }

  console.log(`\n${style.yellow('━'.repeat(64))}`);
  console.log(style.yellow(style.bold('  CLEARANCE REQUIRED')));
  console.log(
    style.dim(
      reviewable.length === 1
        ? '  The agent wants to run 1 action that writes to your repository.'
        : `  The agent wants to run ${reviewable.length} actions that write to your repository.`,
    ),
  );
  console.log(`${style.yellow('━'.repeat(64))}\n`);

  if (!stdin.isTTY) {
    console.log(
      style.red('  No interactive terminal detected - denying by default (fail closed).\n'),
    );
    for (const { call } of reviewable) {
      settle(
        call,
        'denied-no-tty',
        'No human present to approve a repository write (non-interactive session).',
      );
    }
    return decisions;
  }

  const rl = createInterface({ input: stdin, output: stdout });

  // Ctrl-C at an approval prompt is an answer, not an absence of one. Without
  // this the question simply never resolves and the pending write stays open.
  const interrupt = new AbortController();
  let interrupted = false;
  rl.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    interrupt.abort();
  });

  try {
    for (const [index, { call, warnings }] of reviewable.entries()) {
      if (interrupted) {
        settle(
          call,
          'denied-interrupt',
          'The operator interrupted the approval prompt (Ctrl-C). Denied without review.',
        );
        continue;
      }

      renderCall(index + 1, reviewable.length, call, warnings);

      const answer = await ask(rl, `  ${style.bold('Allow this? [y/N] ')}`, interrupt.signal);

      if (answer === undefined) {
        console.log(`\n  ${style.red('INTERRUPTED')} ${style.dim('denying the rest')}\n`);
        settle(
          call,
          'denied-interrupt',
          'The operator interrupted the approval prompt (Ctrl-C). Denied without review.',
        );
        continue;
      }

      const choice = answer.toLowerCase();
      if (choice === 'y' || choice === 'yes') {
        console.log(`  ${style.green('APPROVED')}\n`);
        decisions.push({
          type: 'user.tool_approval',
          threadId: call.threadId,
          toolCallId: call.toolCallId,
          approval: { status: 'allow' },
        });
        journal?.record({
          tool: call.toolName,
          threadId: call.threadId,
          toolCallId: call.toolCallId,
          paths: pathsIn((call.args ?? {}) as Record<string, unknown>),
          outcome: 'approved',
        });
        continue;
      }

      const given = await ask(
        rl,
        `  ${style.dim('Reason for denial (optional): ')}`,
        interrupt.signal,
      );
      const reason = given || 'Denied by the on-call operator.';
      console.log(`  ${style.red('DENIED')} ${style.dim(reason)}\n`);
      settle(call, given === undefined ? 'denied-interrupt' : 'denied', reason);
    }
  } finally {
    rl.close();
  }

  return decisions;
}

/** Ask one question; undefined means the operator interrupted instead of answering. */
async function ask(
  rl: ReturnType<typeof createInterface>,
  query: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return (await rl.question(query, { signal })).trim();
  } catch {
    return undefined;
  }
}

const PAD = '        ';

/**
 * A write that never got to ask. Rendered loudly and distinctly from a denial:
 * a human said no to the second kind, and nobody was consulted about the first.
 */
function renderBlocked(call: PendingCall, offending: Offender[], writePaths: string[]): void {
  console.log(`\n${style.red('━'.repeat(64))}`);
  console.log(style.red(style.bold('  BLOCKED BY WRITE PERIMETER')));
  console.log(style.dim('  Denied automatically. No approval was offered.'));
  console.log(`${style.red('━'.repeat(64))}\n`);

  console.log(`  ${style.bold(style.cyan(call.toolName))}`);
  console.log(
    renderFields(
      [
        ...offending.map(
          (offender): [string, string] => [
            offender.rule === 'excluded' ? 'excluded' : 'outside',
            offender.rule === 'excluded'
              ? `${offender.path}  ${style.dim(`(rule !${offender.pattern})`)}`
              : offender.path,
          ],
        ),
        ['perimeter', writePaths.join(', ')],
      ],
      PAD,
    ),
  );
  console.log('');
}

/**
 * A write carrying something that looks like a credential. Same treatment as a
 * perimeter breach: refused before anyone is invited to wave it through.
 */
function renderTripwire(
  call: PendingCall,
  findings: Array<SecretFinding & { where: string }>,
): void {
  console.log(`\n${style.red('━'.repeat(64))}`);
  console.log(style.red(style.bold('  BLOCKED BY CREDENTIAL TRIPWIRE')));
  console.log(style.dim('  Denied automatically. No approval was offered.'));
  console.log(`${style.red('━'.repeat(64))}\n`);

  console.log(`  ${style.bold(style.cyan(call.toolName))}`);
  console.log(
    renderFields(
      findings.map((finding): [string, string] => ['found', describeFinding(finding)]),
      PAD,
    ),
  );
  console.log(style.dim(`${PAD}set LTP_SECRET_POLICY=warn to review these by hand instead`));
  console.log('');
}

/**
 * Show the operator what they are about to approve.
 *
 * Structured per tool rather than a JSON dump: the fields that locate the write
 * (repo, branch, path), any reason to look twice, and then the payload itself as
 * numbered lines. An unrecognised tool falls back to raw arguments - showing
 * nothing would be worse than showing something ugly.
 */
function renderCall(
  position: number,
  total: number,
  call: PendingCall,
  warnings: Array<SecretFinding & { where: string }>,
): void {
  const summary = summarizeCall(call.toolName, call.args);
  const counter = total > 0 ? `${style.dim(`(${position}/${total})`)} ` : '';

  console.log(`  ${counter}${style.bold(style.cyan(call.toolName))}`);

  const fields = renderFields(summary.fields, PAD);
  if (fields) console.log(fields);

  for (const risk of summary.risks) {
    console.log(`${PAD}${style.yellow(`! ${risk}`)}`);
  }

  for (const warning of warnings) {
    console.log(`${PAD}${style.red(`!! possible ${describeFinding(warning)}`)}`);
  }

  if (summary.body) {
    console.log(`\n${PAD}${style.dim(summary.body.label)}`);
    console.log(indent(numberLines(summary.body.text), PAD));
  }

  if (summary.fields.length === 0 && !summary.body) {
    console.log(style.dim(indent(preview(call.args, 1200), PAD)));
  }

  console.log('');
}

function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
