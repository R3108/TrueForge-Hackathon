import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { style, preview, summarizeCall, renderFields, numberLines } from './render.ts';
import { checkPerimeter } from './perimeter.ts';

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

/**
 * Aliased to the SDK's own type rather than re-declared: this is the payload the
 * approval gate sends back, and a silent key mismatch here would be a safety
 * bug, not a cosmetic one.
 */
export type Decision = TrueForgeApi.UserToolApprovalEvent;

function deny(call: PendingCall, reason: string): Decision {
  return {
    type: 'user.tool_approval',
    threadId: call.threadId,
    toolCallId: call.toolCallId,
    approval: { status: 'deny', reason },
  };
}

/**
 * Ask a human before the agent writes to the repository.
 *
 * This is deliberately a blocking, explicit prompt: the whole safety argument of
 * this project is that the agent cannot mutate a repo while nobody is looking.
 * A non-TTY session (CI, piped input) denies by default rather than silently
 * auto-approving - failing closed is the only safe direction here.
 *
 * Writes outside the declared perimeter never reach the prompt at all. An
 * operator cannot approve what they are never shown, which is the point: the
 * boundary should not be something a tired human can be walked through.
 */
export async function requestClearance(
  pending: PendingCall[],
  writePaths: string[] = [],
): Promise<Decision[]> {
  if (pending.length === 0) return [];

  const decisions: Decision[] = [];
  const reviewable: PendingCall[] = [];

  for (const call of pending) {
    const verdict = checkPerimeter(call.args, writePaths);
    if (verdict.status === 'blocked') {
      decisions.push(
        deny(
          call,
          `Refused by the write perimeter. ${call.toolName} would write to ${verdict.offending.join(', ')}, which is outside the declared perimeter (${writePaths.join(', ')}). No human was asked.`,
        ),
      );
      renderBlocked(call, verdict.offending, writePaths);
    } else {
      reviewable.push(call);
    }
  }

  if (reviewable.length === 0) return decisions;

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
    return [
      ...decisions,
      ...reviewable.map((call) =>
        deny(call, 'No human present to approve a repository write (non-interactive session).'),
      ),
    ];
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    for (const [index, call] of reviewable.entries()) {
      renderCall(index + 1, reviewable.length, call);

      const answer = (await rl.question(`  ${style.bold('Allow this? [y/N] ')}`))
        .trim()
        .toLowerCase();

      if (answer === 'y' || answer === 'yes') {
        console.log(`  ${style.green('APPROVED')}\n`);
        decisions.push({
          type: 'user.tool_approval',
          threadId: call.threadId,
          toolCallId: call.toolCallId,
          approval: { status: 'allow' },
        });
      } else {
        const reason =
          (await rl.question(`  ${style.dim('Reason for denial (optional): ')}`)).trim() ||
          'Denied by the on-call operator.';
        console.log(`  ${style.red('DENIED')} ${style.dim(reason)}\n`);
        decisions.push({
          type: 'user.tool_approval',
          threadId: call.threadId,
          toolCallId: call.toolCallId,
          approval: { status: 'deny', reason },
        });
      }
    }
  } finally {
    rl.close();
  }

  return decisions;
}

const PAD = '        ';

/**
 * A write that never got to ask. Rendered loudly and distinctly from a denial:
 * a human said no to the second kind, and nobody was consulted about the first.
 */
function renderBlocked(call: PendingCall, offending: string[], writePaths: string[]): void {
  console.log(`\n${style.red('━'.repeat(64))}`);
  console.log(style.red(style.bold('  BLOCKED BY WRITE PERIMETER')));
  console.log(style.dim('  Denied automatically. No approval was offered.'));
  console.log(`${style.red('━'.repeat(64))}\n`);

  console.log(`  ${style.bold(style.cyan(call.toolName))}`);
  console.log(
    renderFields(
      [
        ['outside', offending.join(', ')],
        ['perimeter', writePaths.join(', ')],
      ],
      PAD,
    ),
  );
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
function renderCall(position: number, total: number, call: PendingCall): void {
  const summary = summarizeCall(call.toolName, call.args);

  console.log(
    `  ${style.dim(`(${position}/${total})`)} ${style.bold(style.cyan(call.toolName))}`,
  );

  const fields = renderFields(summary.fields, PAD);
  if (fields) console.log(fields);

  for (const risk of summary.risks) {
    console.log(`${PAD}${style.yellow(`! ${risk}`)}`);
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
