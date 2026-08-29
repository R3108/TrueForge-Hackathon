import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { style, preview, summarizeCall, renderFields, numberLines, pathsIn, payloadsIn } from './render.ts';
import { scanPayloads, describeFinding, type SecretPolicy, type SecretFinding } from './secrets.ts';
import type { Journal, Outcome } from './journal.ts';
import type { PendingApproval, PendingResponse } from './contracts.ts';
import type { EvidenceSummary } from './evidence.ts';
import { ToolCallGate, type GateEvaluation } from './gate.ts';

export type ApprovalDecision = TrueForgeApi.UserToolApprovalEvent;
export type ResponseDecision = TrueForgeApi.UserToolResponseEvent;
export type Decision = TrueForgeApi.TurnInputItem;

export interface ClearanceOptions {
  /** What to do about a credential in a payload. Default: block. */
  secretPolicy?: SecretPolicy;
  /** Refuse every write without asking - a full run with nothing at stake. */
  rehearse?: boolean;
  /** Append-only record of what was decided. */
  journal?: Journal;
}

/** A call that survived the automatic checks and needs a person. */
interface Reviewable {
  call: PendingApproval;
  evaluation: GateEvaluation;
  /** Credentials found under a `warn` policy - shown, not enforced. */
  warnings: Array<SecretFinding & { where: string }>;
}

function deny(call: PendingApproval, reason: string): ApprovalDecision {
  return {
    type: 'user.tool_approval',
    threadId: call.invocation.key.threadId,
    toolCallId: call.invocation.key.toolCallId,
    approval: { status: 'deny', reason },
  };
}

function allow(call: PendingApproval): ApprovalDecision {
  return {
    type: 'user.tool_approval',
    threadId: call.invocation.key.threadId,
    toolCallId: call.invocation.key.toolCallId,
    approval: { status: 'allow' },
  };
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
 * Deterministic policy runs first: the tool-call firewall's own repository, path,
 * secret-path, protected-branch and destructive-tool checks, plus the payload
 * credential tripwire. An operator cannot approve what they are never shown,
 * which is the point - a boundary should not be something a tired human can be
 * walked through.
 */
export async function requestClearance(
  pending: PendingApproval[],
  gate: ToolCallGate,
  options: ClearanceOptions = {},
): Promise<ApprovalDecision[]> {
  if (pending.length === 0) return [];

  const { secretPolicy = 'block', rehearse = false, journal } = options;

  const decisions: ApprovalDecision[] = [];
  const reviewable: Reviewable[] = [];

  const settle = (
    call: PendingApproval,
    outcome: Outcome,
    reason: string,
    fingerprint?: string,
  ): void => {
    decisions.push({
      type: 'user.tool_approval',
      threadId: call.invocation.key.threadId,
      toolCallId: call.invocation.key.toolCallId,
      approval: { status: 'deny', reason },
    });
    journal?.record({
      tool: call.invocation.toolName,
      threadId: call.invocation.key.threadId,
      toolCallId: call.invocation.key.toolCallId,
      paths: pathsIn((call.invocation.arguments ?? {}) as Record<string, unknown>),
      outcome,
      reason,
    });
    if (fingerprint) gate.recordManagedDenial(call.invocation, fingerprint, reason);
  };

  for (const call of pending) {
    const replay = gate.processedDecision(call.invocation);
    if (replay) {
      const decision =
        replay.status === 'allow'
          ? allow(call)
          : deny(call, replay.reason ?? 'This required action was already denied.');
      decisions.push(decision);
      journal?.record({
        tool: call.invocation.toolName,
        threadId: call.invocation.key.threadId,
        toolCallId: call.invocation.key.toolCallId,
        paths: pathsIn((call.invocation.arguments ?? {}) as Record<string, unknown>),
        outcome: replay.status === 'allow' ? 'approved' : 'denied',
        reason: replay.reason ?? 'Replay of a recorded decision.',
      });
      continue;
    }

    const evaluation = gate.evaluate(call.invocation);
    const label =
      evaluation.decision.type === 'repair'
        ? 'REPAIR REQUESTED'
        : evaluation.decision.type === 'human_review'
          ? 'HUMAN REVIEW REQUIRED'
          : 'BLOCKED BY TOOL-CALL FIREWALL';

    if (evaluation.decision.type === 'repair' || evaluation.decision.type === 'deny') {
      const reason =
        evaluation.decision.type === 'repair'
          ? evaluation.decision.feedback
          : evaluation.decision.reason;
      const outcome: Outcome =
        evaluation.decision.type === 'deny'
          ? denyOutcome(evaluation.decision.code)
          : 'denied-rehearsal';
      settle(call, outcome, reason, evaluation.fingerprint);
      renderBlocked(call, label, reason);
      continue;
    }

    // Payload tripwire: runs on every field that is persisted in the repository
    // (file content, commit messages, PR/issue bodies, titles, branch names) and
    // on EVERY decision path that can still reach a human - human_review
    // included. Incomplete evidence is a reason to involve the operator, not a
    // licence to skip the scan: a secret-bearing PR body must be refused under
    // secretPolicy 'block' before anyone can approve it.
    const findings =
      secretPolicy === 'off'
        ? []
        : scanPayloads(payloadsIn((call.invocation.arguments ?? {}) as Record<string, unknown>));

    if (findings.length > 0 && secretPolicy === 'block') {
      const reason = `Refused by the credential tripwire. The payload of ${call.invocation.toolName} contains ${findings
        .map((finding) => `${finding.label} (${finding.where}:${finding.line})`)
        .join(', ')}. Remove the credential and read it from the environment instead. No human was asked.`;
      settle(call, 'blocked-secret', reason, evaluation.fingerprint);
      renderTripwire(call, findings);
      continue;
    }

    if (evaluation.decision.type === 'human_review') {
      // Incomplete evidence is a reason to involve the human, not to refuse:
      // renderApprovalCard surfaces exactly what is missing.
      reviewable.push({ call, evaluation, warnings: findings });
      continue;
    }

    // An application allow can never weaken TrueForge's core approval
    // requirement - approval-required events always reach a human.
    reviewable.push({
      call,
      evaluation:
        evaluation.decision.type === 'allow'
          ? {
              ...evaluation,
              decision: {
                type: 'require_approval',
                reasons: ['Core TrueForge approval remains required.'],
              },
            }
          : evaluation,
      warnings: findings,
    });
  }

  if (reviewable.length === 0) return decisions;

  if (rehearse) {
    console.log(`\n${style.blue('━'.repeat(72))}`);
    console.log(style.blue(style.bold('  REHEARSAL')));
    console.log(
      style.dim(
        `  ${reviewable.length} write(s) would have been offered for approval. Refusing all.`,
      ),
    );
    console.log(`${style.blue('━'.repeat(72))}\n`);

    for (const { call, evaluation } of reviewable) {
      renderApprovalCard(0, 0, call, evaluation, []);
      settle(
        call,
        'denied-rehearsal',
        'Rehearsal run (--rehearse): repository writes are refused by policy. Continue as if this were denied by the operator.',
        evaluation.fingerprint,
      );
    }
    return decisions;
  }

  console.log(`\n${style.yellow('━'.repeat(72))}`);
  console.log(style.yellow(style.bold('  EVIDENCE-AWARE CLEARANCE REQUIRED')));
  console.log(
    style.dim(
      `  ${reviewable.length} exact action${reviewable.length === 1 ? '' : 's'} await a human decision.`,
    ),
  );
  console.log(`${style.yellow('━'.repeat(72))}\n`);

  if (!stdin.isTTY) {
    console.log(style.red('  No interactive terminal detected - denying by default (fail closed).\n'));
    for (const { call, evaluation } of reviewable) {
      const reason = 'No human present to approve a sensitive write (non-interactive session).';
      decisions.push(deny(call, reason));
      gate.recordHumanDecision(call.invocation, evaluation.fingerprint, 'deny', reason);
      journal?.record({
        tool: call.invocation.toolName,
        threadId: call.invocation.key.threadId,
        toolCallId: call.invocation.key.toolCallId,
        paths: pathsIn((call.invocation.arguments ?? {}) as Record<string, unknown>),
        outcome: 'denied-no-tty',
        reason,
      });
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
    for (const [index, item] of reviewable.entries()) {
      if (interrupted) {
        settle(
          item.call,
          'denied-interrupt',
          'The operator interrupted the approval prompt (Ctrl-C). Denied without review.',
          item.evaluation.fingerprint,
        );
        continue;
      }

      const terminal = gate.processedDecision(item.call.invocation);
      if (terminal?.status === 'deny') {
        const reason = terminal.reason ?? 'A prior human denial is terminal.';
        decisions.push(deny(item.call, reason));
        journal?.record({
          tool: item.call.invocation.toolName,
          threadId: item.call.invocation.key.threadId,
          toolCallId: item.call.invocation.key.toolCallId,
          paths: pathsIn((item.call.invocation.arguments ?? {}) as Record<string, unknown>),
          outcome: 'denied',
          reason,
        });
        renderBlocked(item.call, 'BLOCKED BY TERMINAL HUMAN DENIAL', reason);
        continue;
      }

      renderApprovalCard(index + 1, reviewable.length, item.call, item.evaluation, item.warnings);

      const answer = await ask(rl, `  ${style.bold('Approve this exact call once? [y/N] ')}`, interrupt.signal);
      if (answer === undefined) {
        console.log(`\n  ${style.red('INTERRUPTED')} ${style.dim('denying the rest')}\n`);
        settle(
          item.call,
          'denied-interrupt',
          'The operator interrupted the approval prompt (Ctrl-C). Denied without review.',
          item.evaluation.fingerprint,
        );
        continue;
      }

      const choice = answer.trim().toLowerCase();
      if (choice === 'y' || choice === 'yes') {
        decisions.push(allow(item.call));
        gate.recordHumanDecision(item.call.invocation, item.evaluation.fingerprint, 'allow');
        console.log(`  ${style.green('APPROVED ONCE')}\n`);
        journal?.record({
          tool: item.call.invocation.toolName,
          threadId: item.call.invocation.key.threadId,
          toolCallId: item.call.invocation.key.toolCallId,
          paths: pathsIn((item.call.invocation.arguments ?? {}) as Record<string, unknown>),
          outcome: 'approved',
        });
        continue;
      }

      const given = await ask(rl, `  ${style.dim('Reason for denial (optional): ')}`, interrupt.signal);
      const reason = (given ?? '').trim() || 'Denied by the on-call operator.';
      console.log(`  ${style.red('DENIED')} ${style.dim(reason)}\n`);
      decisions.push(deny(item.call, reason));
      gate.recordHumanDecision(item.call.invocation, item.evaluation.fingerprint, 'deny', reason);
      journal?.record({
        tool: item.call.invocation.toolName,
        threadId: item.call.invocation.key.threadId,
        toolCallId: item.call.invocation.key.toolCallId,
        paths: pathsIn((item.call.invocation.arguments ?? {}) as Record<string, unknown>),
        outcome: given === undefined ? 'denied-interrupt' : 'denied',
        reason,
      });
    }
  } finally {
    rl.close();
  }

  return decisions;
}

/** Map a firewall deny code onto the journal's outcome vocabulary. */
function denyOutcome(code: string): Outcome {
  if (code === 'outside_write_perimeter') return 'blocked-perimeter';
  if (code === 'secret_path') return 'blocked-secret';
  return 'denied';
}

/** Response-required calls are client responses, never approval decisions. */
export async function requestResponses(
  pending: PendingResponse[],
  gate?: ToolCallGate,
): Promise<ResponseDecision[]> {
  if (pending.length === 0) return [];

  const rl = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : undefined;
  try {
    const responses: ResponseDecision[] = [];
    for (const call of pending) {
      if (gate?.isConfiguredWrite(call.invocation)) {
        const reason =
          'Configured GitHub write arrived as tool.response_required; sensitive writes require the approval protocol.';
        const replay = gate.processedDecision(call.invocation);
        if (!replay) {
          const evaluation = gate.evaluate(call.invocation);
          gate.recordManagedDenial(call.invocation, evaluation.fingerprint, reason);
        }
        responses.push({
          type: 'user.tool_response',
          threadId: call.invocation.key.threadId,
          toolCallId: call.invocation.key.toolCallId,
          content: JSON.stringify({
            error: 'unexpected_required_action_kind',
            repairable: false,
            reason,
          }),
        });
        continue;
      }

      if (!rl) {
        responses.push({
          type: 'user.tool_response',
          threadId: call.invocation.key.threadId,
          toolCallId: call.invocation.key.toolCallId,
          content: JSON.stringify({ error: 'human_response_unavailable', repairable: false }),
        });
        continue;
      }

      console.log(`\n  ${style.bold(style.cyan(call.invocation.toolName))}`);
      console.log(style.dim(`  Client response required for ${call.invocation.key.toolCallId}.`));
      console.log(style.dim(preview(call.invocation.arguments, 1200)));
      const content = await rl.question(`  ${style.bold('Response: ')}`);
      responses.push({
        type: 'user.tool_response',
        threadId: call.invocation.key.threadId,
        toolCallId: call.invocation.key.toolCallId,
        content,
      });
    }
    return responses;
  } finally {
    rl?.close();
  }
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

function renderBlocked(call: PendingApproval, title: string, reason: string): void {
  console.log(`\n${style.red('━'.repeat(72))}`);
  console.log(style.red(style.bold(`  ${title}`)));
  console.log(style.dim('  Denied automatically. No approval was offered.'));
  console.log(`${style.red('━'.repeat(72))}\n`);
  console.log(`  ${style.bold(style.cyan(call.invocation.toolName))}`);
  console.log(renderFields([['call ID', call.invocation.key.toolCallId], ['reason', reason]], PAD));
  console.log('');
}

function check(mark: boolean, text: string): string {
  return `${mark ? style.green('✓') : style.yellow('!')} ${text}`;
}

function evidenceLines(evidence: EvidenceSummary): string[] {
  const regression = evidence.regressionObserved
    ? evidence.regressionIsHistorical
      ? 'Regression reproduced (historical baseline; later mutation observed)'
      : 'Regression reproduced at current workspace epoch'
    : 'Regression reproduction not observed';
  return [
    check(evidence.regressionObserved, regression),
    check(evidence.targetedTestPassed, 'Targeted regression test passed at current epoch'),
    check(evidence.fullSuitePassed, 'Full suite passed at current epoch'),
    ...(evidence.unverifiedSuccessObserved
      ? [style.yellow('! Output mentions success, but no structured exit status verified it')]
      : []),
    style.dim(`workspace epoch ${evidence.workspaceEpoch}`),
  ];
}

/**
 * Show the operator what they are about to approve: the exact call ID, the
 * fingerprint the decision is bound to, the policy preflight, observed test
 * evidence, any credential warnings, and every payload - so one "y" never
 * authorises a file the operator never saw.
 */
export function renderApprovalCard(
  position: number,
  total: number,
  call: PendingApproval,
  evaluation: GateEvaluation,
  warnings: Array<SecretFinding & { where: string }> = [],
): void {
  const invocation = call.invocation;
  const summary = summarizeCall(invocation.toolName, invocation.arguments);
  console.log(`  ${total > 0 ? `${style.dim(`(${position}/${total})`)} ` : ''}${style.bold(style.cyan(invocation.toolName))}`);
  const fields = renderFields(
    [
      ['call ID', invocation.key.toolCallId],
      ['fingerprint', evaluation.fingerprint.slice(0, 16)],
      ['repair budget', `${evaluation.repairAttempt} / 2`],
      ...summary.fields,
    ],
    PAD,
  );
  if (fields) console.log(fields);

  console.log(`\n${PAD}${style.bold('Policy')}`);
  const decisionReason =
    evaluation.decision.type === 'human_review'
      ? evaluation.decision.reason
      : evaluation.decision.type === 'require_approval'
        ? evaluation.decision.reasons.join(' ')
        : 'Policy preflight completed.';
  console.log(`${PAD}${check(true, 'Exact repository and perimeter preflight completed')}`);
  console.log(`${PAD}${check(true, 'Approval is bound to this call ID and fingerprint')}`);
  console.log(`${PAD}${style.dim(decisionReason)}`);

  console.log(`\n${PAD}${style.bold('Observed evidence')}`);
  for (const line of evidenceLines(evaluation.evidence)) console.log(`${PAD}${line}`);

  for (const warning of warnings) {
    console.log(`${PAD}${style.red(`!! possible ${describeFinding(warning)}`)}`);
  }

  for (const risk of summary.risks) console.log(`${PAD}${style.yellow(`! ${risk}`)}`);

  // Every payload, so one "y" never authorises a file the operator never saw.
  for (const body of summary.bodies) {
    console.log(`\n${PAD}${style.dim(body.label)}`);
    if (body.text === '') console.log(`${PAD}${style.red('(no content)')}`);
    else console.log(indent(numberLines(body.text), PAD));
  }

  if (summary.fields.length === 0 && summary.bodies.length === 0) {
    console.log(style.dim(indent(preview(invocation.arguments, 1200), PAD)));
  }
  console.log('');
}

/**
 * A write carrying something that looks like a credential. Same treatment as a
 * perimeter breach: refused before anyone is invited to wave it through.
 */
function renderTripwire(
  call: PendingApproval,
  findings: Array<SecretFinding & { where: string }>,
): void {
  console.log(`\n${style.red('━'.repeat(72))}`);
  console.log(style.red(style.bold('  BLOCKED BY CREDENTIAL TRIPWIRE')));
  console.log(style.dim('  Denied automatically. No approval was offered.'));
  console.log(`${style.red('━'.repeat(72))}\n`);

  console.log(`  ${style.bold(style.cyan(call.invocation.toolName))}`);
  console.log(
    renderFields(
      findings.map((finding): [string, string] => ['found', describeFinding(finding)]),
      PAD,
    ),
  );
  console.log(style.dim(`${PAD}set LTP_SECRET_POLICY=warn to review these by hand instead`));
  console.log('');
}

function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
