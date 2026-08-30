/**
 * Backward-compatible UI display for the adaptive kernel's *informational* state.
 *
 * The adaptive kernel (src/runtime/kernel) already produces additive, durable
 * informational facts — a task contract, an event-derived working state, a
 * deterministic context budget plan, replan revisions, a verification decision,
 * and least-privilege delegation contracts. Until now none of it surfaced in the
 * UI; the streaming turn in `run.ts` only rendered tool calls and required
 * actions.
 *
 * This module renders that informational state through the *existing* event
 * path and terminal UI conventions in {@link ./render.ts} (the same `style`,
 * `table`, and dim/aligned-field idioms used for tool-call summaries). Every
 * function here is:
 *
 *   - PURE — it takes typed kernel state and returns a string, so it is trivially
 *     unit-testable and never performs I/O itself; and
 *   - ADDITIVE — the caller emits these lines alongside, never instead of, the
 *     existing output. A client that ignores informational events (or is not a
 *     TTY at all) is unaffected, and REQUIRED ACTIONS remain a wholly separate
 *     path (approvals/responses in run.ts) that this module never touches.
 *
 * The informational surface is deliberately read-only and secret-free: it only
 * echoes fields the kernel already redacted and deemed persistable.
 */

import { style, table } from './render.ts';
import type { TaskContract } from './kernel/contract.ts';
import type { WorkingState, PlanStep, Phase } from './kernel/working-state.ts';
import type { ContextBudgetPlan } from './kernel/context.ts';
import type { CompletionDecision } from './kernel/verification.ts';
import type { DelegationContract, DelegationOutcome } from './kernel/delegation.ts';

/** A rendered informational block: a heading plus zero or more body lines. */
export interface InfoBlock {
  /** Stable machine key, mirroring the kernel's reserved capability_state keys. */
  key: string;
  /** Human heading shown in the terminal. */
  heading: string;
  /** Body lines already styled for the terminal. */
  lines: string[];
}

/** Join a block into printable text, or '' when there is nothing to show. */
export function renderBlock(block: InfoBlock): string {
  if (block.lines.length === 0) return '';
  return [`${style.cyan('ⓘ')} ${style.bold(block.heading)}`, ...block.lines.map((l) => `  ${l}`)].join('\n');
}

const PHASE_LABEL: Record<Phase, string> = {
  understanding: 'understanding',
  retrieving: 'retrieving',
  planning: 'planning',
  executing: 'executing',
  verifying: 'verifying',
  blocked: 'blocked',
  complete: 'complete',
};

const STEP_MARK: Record<PlanStep['status'], string> = {
  pending: '·',
  active: '▸',
  done: '✓',
  abandoned: '✗',
};

/**
 * 1) Task objective + status. Shows what the harness believes it was asked to
 * do, the derived task type, the current contract status/revision, and whether
 * the request bypassed full compilation (a simple question). Blocking
 * ambiguities are surfaced so an operator sees *why* a task is blocked.
 */
export function renderTaskObjective(contract: TaskContract): InfoBlock {
  const lines: string[] = [];
  lines.push(`${style.dim('objective')}  ${contract.objective || '(none)'}`);
  const meta = [
    `type ${contract.taskType}`,
    `status ${statusStyle(contract.status)}`,
    `rev ${contract.revision}`,
    `risk ${contract.risk}`,
  ];
  if (contract.bypassed) meta.push(style.dim('bypassed (simple question)'));
  if (contract.fallback) meta.push(style.yellow('fallback compilation'));
  lines.push(`${style.dim('contract')}   ${meta.join(style.dim(' · '))}`);

  const blocking = contract.ambiguities.filter((a) => a.blocking);
  if (blocking.length > 0) {
    lines.push(style.yellow('blocking ambiguities:'));
    for (const a of blocking) lines.push(`  ${style.yellow('!')} ${a.text}`);
  }
  return { key: 'kernel.task_contract', heading: 'Task', lines };
}

function statusStyle(status: TaskContract['status']): string {
  switch (status) {
    case 'satisfied':
      return style.green(status);
    case 'blocked':
    case 'cancelled':
      return style.yellow(status);
    default:
      return status;
  }
}

/**
 * 2) Current phase + plan progress. Renders the live phase and a checklist of
 * plan steps with pending/active/done/abandoned markers, plus a compact
 * "n/total done" progress tally.
 */
export function renderPhaseAndPlan(state: WorkingState): InfoBlock {
  const lines: string[] = [];
  lines.push(`${style.dim('phase')}  ${phaseStyle(state.phase)}`);
  if (state.plan.length > 0) {
    const done = state.plan.filter((s) => s.status === 'done').length;
    lines.push(`${style.dim('plan')}   ${done}/${state.plan.length} done`);
    for (const step of state.plan) {
      lines.push(`  ${stepStyle(step)} ${step.text}`);
    }
  }
  return { key: 'kernel.working_state', heading: 'Progress', lines };
}

function phaseStyle(phase: Phase): string {
  const label = PHASE_LABEL[phase];
  if (phase === 'complete') return style.green(label);
  if (phase === 'blocked') return style.yellow(label);
  return style.cyan(label);
}

function stepStyle(step: PlanStep): string {
  const mark = STEP_MARK[step.status];
  switch (step.status) {
    case 'done':
      return style.green(mark);
    case 'active':
      return style.cyan(mark);
    case 'abandoned':
      return style.dim(mark);
    default:
      return style.dim(mark);
  }
}

/**
 * 3) Context plan / compaction. Shows the deterministic context budget the
 * kernel planned for the current model window: how much of the window is pinned
 * (protected from compaction), reserved for output, and left for the recent
 * tail / relevant history / tool schemas. This is the SDK-compaction companion
 * view — the SDK still compacts the conversation tail; the kernel reports the
 * budget it planned around it.
 */
export function renderContextPlan(plan: ContextBudgetPlan): InfoBlock {
  const rows: string[][] = [
    ['pinned', String(plan.pinnedBudget)],
    ['recent tail', String(plan.recentTailBudget)],
    ['relevant history', String(plan.relevantHistoryBudget)],
    ['tool schemas', String(plan.toolSchemaBudget)],
    ['reserved output', String(plan.reservedOutputTokens)],
    ['safety margin', String(plan.safetyMargin)],
  ];
  const lines: string[] = [];
  lines.push(`${style.dim('window')}  ${plan.contextWindow} tokens`);
  lines.push(...table(['budget', 'tokens'], rows).split('\n'));
  return { key: 'kernel.context_plan', heading: 'Context plan', lines };
}

/**
 * 4) Replan notice. Emitted when a user correction produced a NEW contract
 * revision (history preserved) or the plan was reset. Purely informational; it
 * never mutates or re-runs anything.
 */
export function renderReplanNotice(revision: number, reason?: string): InfoBlock {
  const detail = reason ? ` — ${reason}` : '';
  return {
    key: 'kernel.task_contract',
    heading: 'Replan',
    lines: [`${style.yellow('↻')} contract revised to revision ${revision}${detail}`],
  };
}

/**
 * 5) Verification status + blockers. Shows whether the harness could verify
 * completion from typed evidence, and — when it could not — the exact blocking
 * reasons. When a success-sounding output was blocked and rewritten, that fact
 * is surfaced explicitly so an operator understands the final text was corrected
 * by the harness, not the model.
 */
export function renderVerification(decision: CompletionDecision): InfoBlock {
  const lines: string[] = [];
  const status = decision.satisfied
    ? style.green('satisfied')
    : style.yellow('incomplete');
  lines.push(`${style.dim('status')}  ${status}`);
  if (decision.falseCompletionBlocked) {
    lines.push(style.yellow('a claimed success was blocked and rewritten truthfully'));
  }
  if (decision.blockingReasons.length > 0) {
    lines.push(style.dim('blockers:'));
    for (const reason of decision.blockingReasons) lines.push(`  ${style.yellow('✗')} ${reason}`);
  }
  return { key: 'kernel.verification', heading: 'Verification', lines };
}

/**
 * 6) Delegation ownership + status. Renders the outcome of a least-privilege
 * subagent delegation: on success, the child's objective, granted capabilities,
 * owned write resources, and depth; on denial, the typed denial code and reason.
 */
export function renderDelegation(outcome: DelegationOutcome): InfoBlock {
  if (!outcome.ok) {
    return {
      key: 'kernel.delegation',
      heading: 'Delegation',
      lines: [`${style.yellow('denied')} ${style.dim(`(${outcome.code})`)} ${outcome.reason}`],
    };
  }
  return renderDelegationContract(outcome.contract);
}

/** Render a granted delegation contract's ownership and status. */
export function renderDelegationContract(contract: DelegationContract): InfoBlock {
  const lines: string[] = [];
  lines.push(`${style.green('granted')} ${style.dim(contract.delegationId)} ${style.dim(`(depth ${contract.depth}/${contract.maxDepth})`)}`);
  lines.push(`${style.dim('objective')}     ${contract.objective}`);
  lines.push(
    `${style.dim('capabilities')}  ${contract.allowedToolCapabilities.length > 0 ? contract.allowedToolCapabilities.join(', ') : '(none)'}`,
  );
  lines.push(
    `${style.dim('owns')}          ${contract.resourceOwnership.length > 0 ? contract.resourceOwnership.join(', ') : '(no write resources)'}`,
  );
  if (contract.deniedToolCapabilities.length > 0) {
    lines.push(`${style.dim('denied')}        ${contract.deniedToolCapabilities.join(', ')}`);
  }
  return { key: 'kernel.delegation', heading: 'Delegation', lines };
}
