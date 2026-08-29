import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { style, preview, summarizeCall, renderFields, numberLines } from './render.ts';
import type { PendingApproval, PendingResponse } from './contracts.ts';
import type { EvidenceSummary } from './evidence.ts';
import { ToolCallGate, type GateEvaluation } from './gate.ts';

export type ApprovalDecision = TrueForgeApi.UserToolApprovalEvent;
export type ResponseDecision = TrueForgeApi.UserToolResponseEvent;
export type Decision = TrueForgeApi.TurnInputItem;

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

/** Apply deterministic policy before offering only exact, reviewable calls to a human. */
export async function requestClearance(
  pending: PendingApproval[],
  gate: ToolCallGate,
): Promise<ApprovalDecision[]> {
  if (pending.length === 0) return [];

  const decisions: ApprovalDecision[] = [];
  const reviewable: Array<{ call: PendingApproval; evaluation: GateEvaluation }> = [];

  for (const call of pending) {
    const replay = gate.processedDecision(call.invocation);
    if (replay) {
      decisions.push(
        replay.status === 'allow'
          ? allow(call)
          : deny(call, replay.reason ?? 'This required action was already denied.'),
      );
      continue;
    }

    const evaluation = gate.evaluate(call.invocation);
    if (evaluation.decision.type === 'repair') {
      const decision = deny(call, evaluation.decision.feedback);
      decisions.push(decision);
      gate.recordManagedDenial(call.invocation, evaluation.fingerprint, evaluation.decision.feedback);
      renderBlocked(call, 'REPAIR REQUESTED', evaluation.decision.feedback);
    } else if (evaluation.decision.type === 'deny') {
      const decision = deny(call, evaluation.decision.reason);
      decisions.push(decision);
      gate.recordManagedDenial(call.invocation, evaluation.fingerprint, evaluation.decision.reason);
      renderBlocked(call, 'BLOCKED BY TOOL-CALL FIREWALL', evaluation.decision.reason);
    } else if (evaluation.decision.type === 'allow') {
      // Approval-required events are never auto-approved: an application allow
      // cannot weaken TrueForge's core requirement.
      reviewable.push({ call, evaluation: { ...evaluation, decision: { type: 'require_approval', reasons: ['Core TrueForge approval remains required.'] } } });
    } else {
      reviewable.push({ call, evaluation });
    }
  }

  if (reviewable.length === 0) return decisions;

  console.log(`\n${style.yellow('━'.repeat(72))}`);
  console.log(style.yellow(style.bold('  EVIDENCE-AWARE CLEARANCE REQUIRED')));
  console.log(style.dim(`  ${reviewable.length} exact action${reviewable.length === 1 ? '' : 's'} await a human decision.`));
  console.log(`${style.yellow('━'.repeat(72))}\n`);

  if (!stdin.isTTY) {
    console.log(style.red('  No interactive terminal detected - denying by default (fail closed).\n'));
    for (const { call, evaluation } of reviewable) {
      const reason = 'No human present to approve a sensitive write (non-interactive session).';
      decisions.push(deny(call, reason));
      gate.recordHumanDecision(call.invocation, evaluation.fingerprint, 'deny', reason);
    }
    return decisions;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (const [index, item] of reviewable.entries()) {
      const terminal = gate.processedDecision(item.call.invocation);
      if (terminal?.status === 'deny') {
        decisions.push(deny(item.call, terminal.reason ?? 'A prior human denial is terminal.'));
        renderBlocked(
          item.call,
          'BLOCKED BY TERMINAL HUMAN DENIAL',
          terminal.reason ?? 'A prior human denial is terminal.',
        );
        continue;
      }
      renderApprovalCard(index + 1, reviewable.length, item.call, item.evaluation);
      const answer = (await rl.question(`  ${style.bold('Approve this exact call once? [y/N] ')}`))
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        decisions.push(allow(item.call));
        gate.recordHumanDecision(item.call.invocation, item.evaluation.fingerprint, 'allow');
        console.log(`  ${style.green('APPROVED ONCE')}\n`);
      } else {
        const reason =
          (await rl.question(`  ${style.dim('Reason for denial (optional): ')}`)).trim() ||
          'Denied by the on-call operator.';
        decisions.push(deny(item.call, reason));
        gate.recordHumanDecision(item.call.invocation, item.evaluation.fingerprint, 'deny', reason);
        console.log(`  ${style.red('DENIED')} ${style.dim(reason)}\n`);
      }
    }
  } finally {
    rl.close();
  }

  return decisions;
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

export function renderApprovalCard(
  position: number,
  total: number,
  call: PendingApproval,
  evaluation: GateEvaluation,
): void {
  const invocation = call.invocation;
  const summary = summarizeCall(invocation.toolName, invocation.arguments);
  console.log(`  ${style.dim(`(${position}/${total})`)} ${style.bold(style.cyan(invocation.toolName))}`);
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

  for (const risk of summary.risks) console.log(`${PAD}${style.yellow(`! ${risk}`)}`);
  if (summary.body) {
    console.log(`\n${PAD}${style.dim(summary.body.label)}`);
    console.log(indent(numberLines(summary.body.text), PAD));
  }
  if (summary.fields.length === 0 && !summary.body) {
    console.log(style.dim(indent(preview(invocation.arguments, 1200), PAD)));
  }
  console.log('');
}

function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
