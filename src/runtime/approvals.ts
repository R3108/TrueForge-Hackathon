import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { style, preview } from './render.ts';

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

export interface Decision {
  type: 'user.tool_approval';
  thread_id: string;
  tool_call_id: string;
  approval: { status: 'allow' } | { status: 'deny'; reason: string };
}

/**
 * Ask a human before the agent writes to the repository.
 *
 * This is deliberately a blocking, explicit prompt: the whole safety argument of
 * this project is that the agent cannot mutate a repo while nobody is looking.
 * A non-TTY session (CI, piped input) denies by default rather than silently
 * auto-approving - failing closed is the only safe direction here.
 */
export async function requestClearance(pending: PendingCall[]): Promise<Decision[]> {
  if (pending.length === 0) return [];

  console.log(`\n${style.yellow('━'.repeat(64))}`);
  console.log(style.yellow(style.bold('  CLEARANCE REQUIRED')));
  console.log(
    style.dim(
      `  The agent wants to run ${pending.length} action${pending.length === 1 ? '' : 's'} that write to your repository.`,
    ),
  );
  console.log(`${style.yellow('━'.repeat(64))}\n`);

  if (!stdin.isTTY) {
    console.log(
      style.red('  No interactive terminal detected - denying by default (fail closed).\n'),
    );
    return pending.map((call) => ({
      type: 'user.tool_approval' as const,
      thread_id: call.threadId,
      tool_call_id: call.toolCallId,
      approval: {
        status: 'deny' as const,
        reason: 'No human present to approve a repository write (non-interactive session).',
      },
    }));
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const decisions: Decision[] = [];

  try {
    for (const [index, call] of pending.entries()) {
      console.log(
        `  ${style.dim(`(${index + 1}/${pending.length})`)} ${style.bold(style.cyan(call.toolName))}`,
      );
      console.log(`${style.dim(indent(preview(call.args, 1200)))}\n`);

      const answer = (await rl.question(`  ${style.bold('Allow this? [y/N] ')}`))
        .trim()
        .toLowerCase();

      if (answer === 'y' || answer === 'yes') {
        console.log(`  ${style.green('APPROVED')}\n`);
        decisions.push({
          type: 'user.tool_approval',
          thread_id: call.threadId,
          tool_call_id: call.toolCallId,
          approval: { status: 'allow' },
        });
      } else {
        const reason =
          (await rl.question(`  ${style.dim('Reason for denial (optional): ')}`)).trim() ||
          'Denied by the on-call operator.';
        console.log(`  ${style.red('DENIED')} ${style.dim(reason)}\n`);
        decisions.push({
          type: 'user.tool_approval',
          thread_id: call.threadId,
          tool_call_id: call.toolCallId,
          approval: { status: 'deny', reason },
        });
      }
    }
  } finally {
    rl.close();
  }

  return decisions;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
