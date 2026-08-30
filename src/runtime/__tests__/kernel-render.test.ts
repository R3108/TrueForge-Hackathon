import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderBlock,
  renderTaskObjective,
  renderPhaseAndPlan,
  renderContextPlan,
  renderReplanNotice,
  renderVerification,
  renderDelegation,
  renderDelegationContract,
  type InfoBlock,
} from '../kernel-render.ts';
import type { TaskContract } from '../kernel/contract.ts';
import type { WorkingState } from '../kernel/working-state.ts';
import type { ContextBudgetPlan } from '../kernel/context.ts';
import type { CompletionDecision } from '../kernel/verification.ts';
import type { DelegationContract } from '../kernel/delegation.ts';

// Tests run without a TTY, so render.ts disables ANSI colour: assertions match
// plain text. That is exactly the "client that ignores styling" compatibility
// path the task requires — the informational text is readable either way.

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    version: 1,
    taskId: 'task-1',
    objective: 'Fix the null deref in cart totals',
    taskType: 'bug_fix',
    constraints: [],
    acceptanceCriteria: [],
    requiredEvidence: [],
    referencedResources: [],
    ambiguities: [],
    risk: 'high',
    status: 'active',
    revision: 1,
    bypassed: false,
    fallback: false,
    policyVersion: 'v1',
    ...overrides,
  };
}

function workingState(overrides: Partial<WorkingState> = {}): WorkingState {
  return {
    taskId: 'task-1',
    contractRevision: 1,
    phase: 'executing',
    plan: [],
    activeStepIds: [],
    observedFacts: [],
    touchedResources: [],
    attemptedApproaches: [],
    unresolvedErrors: [],
    evidence: [],
    remainingCriteria: [],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('renderBlock', () => {
  test('returns empty string when there is nothing to show', () => {
    const empty: InfoBlock = { key: 'kernel.working_state', heading: 'Progress', lines: [] };
    assert.equal(renderBlock(empty), '');
  });

  test('renders heading and indented body lines', () => {
    const block: InfoBlock = { key: 'kernel.task_contract', heading: 'Task', lines: ['a', 'b'] };
    const out = renderBlock(block);
    assert.match(out, /Task/);
    assert.match(out, /\n {2}a/);
    assert.match(out, /\n {2}b/);
  });
});

describe('renderTaskObjective (objective + status)', () => {
  test('shows objective, type, status, revision and risk', () => {
    const out = renderBlock(renderTaskObjective(contract()));
    assert.match(out, /Fix the null deref in cart totals/);
    assert.match(out, /type bug_fix/);
    assert.match(out, /status active/);
    assert.match(out, /rev 1/);
    assert.match(out, /risk high/);
  });

  test('marks a bypassed simple question', () => {
    const out = renderBlock(renderTaskObjective(contract({ taskType: 'question', bypassed: true })));
    assert.match(out, /bypassed/);
  });

  test('surfaces blocking ambiguities as the reason a task is blocked', () => {
    const out = renderBlock(
      renderTaskObjective(
        contract({
          status: 'blocked',
          ambiguities: [
            { id: 'a1', text: 'Two candidate approaches; unclear which.', blocking: true },
            { id: 'a2', text: 'non-blocking note', blocking: false },
          ],
        }),
      ),
    );
    assert.match(out, /status blocked/);
    assert.match(out, /Two candidate approaches/);
    assert.doesNotMatch(out, /non-blocking note/);
  });

  test('uses the stable kernel.task_contract key', () => {
    assert.equal(renderTaskObjective(contract()).key, 'kernel.task_contract');
  });
});

describe('renderPhaseAndPlan (phase + plan progress)', () => {
  test('renders phase with no plan', () => {
    const out = renderBlock(renderPhaseAndPlan(workingState({ phase: 'verifying' })));
    assert.match(out, /phase/);
    assert.match(out, /verifying/);
  });

  test('renders a plan checklist with a done tally', () => {
    const out = renderBlock(
      renderPhaseAndPlan(
        workingState({
          plan: [
            { id: 's1', text: 'reproduce', status: 'done' },
            { id: 's2', text: 'write fix', status: 'active' },
            { id: 's3', text: 'open pr', status: 'pending' },
          ],
        }),
      ),
    );
    assert.match(out, /1\/3 done/);
    assert.match(out, /reproduce/);
    assert.match(out, /write fix/);
    assert.match(out, /open pr/);
  });

  test('uses the stable kernel.working_state key', () => {
    assert.equal(renderPhaseAndPlan(workingState()).key, 'kernel.working_state');
  });
});

describe('renderContextPlan (context plan / compaction)', () => {
  const plan: ContextBudgetPlan = {
    contextWindow: 100_000,
    reservedOutputTokens: 25_000,
    pinnedBudget: 8_000,
    recentTailBudget: 30_000,
    relevantHistoryBudget: 20_000,
    toolSchemaBudget: 12_000,
    safetyMargin: 5_000,
  };

  test('reports the window and every budget category', () => {
    const out = renderBlock(renderContextPlan(plan));
    assert.match(out, /100000 tokens/);
    assert.match(out, /pinned/);
    assert.match(out, /recent tail/);
    assert.match(out, /relevant history/);
    assert.match(out, /tool schemas/);
    assert.match(out, /reserved output/);
    assert.match(out, /safety margin/);
    assert.match(out, /8000/);
  });

  test('uses the stable kernel.context_plan key', () => {
    assert.equal(renderContextPlan(plan).key, 'kernel.context_plan');
  });
});

describe('renderReplanNotice (replan notices)', () => {
  test('reports the new revision and optional reason', () => {
    const out = renderBlock(renderReplanNotice(2, 'user correction'));
    assert.match(out, /Replan/);
    assert.match(out, /revision 2/);
    assert.match(out, /user correction/);
  });

  test('works without a reason', () => {
    const out = renderBlock(renderReplanNotice(3));
    assert.match(out, /revision 3/);
  });
});

describe('renderVerification (verification status + blockers)', () => {
  test('reports a satisfied verification', () => {
    const decision: CompletionDecision = {
      satisfied: true,
      output: 'done',
      falseCompletionBlocked: false,
      results: [],
      blockingReasons: [],
    };
    const out = renderBlock(renderVerification(decision));
    assert.match(out, /satisfied/);
  });

  test('reports blockers and a rewritten false success', () => {
    const decision: CompletionDecision = {
      satisfied: false,
      output: 'INCOMPLETE ...',
      falseCompletionBlocked: true,
      results: [],
      blockingReasons: [
        'required-evidence: Targeted test passes (missing)',
        'no-pending-required-actions: No required action is awaiting a human. (failed)',
      ],
    };
    const out = renderBlock(renderVerification(decision));
    assert.match(out, /incomplete/);
    assert.match(out, /blocked and rewritten/);
    assert.match(out, /Targeted test passes/);
    assert.match(out, /awaiting a human/);
  });

  test('uses the stable kernel.verification key', () => {
    const decision: CompletionDecision = {
      satisfied: true,
      output: '',
      falseCompletionBlocked: false,
      results: [],
      blockingReasons: [],
    };
    assert.equal(renderVerification(decision).key, 'kernel.verification');
  });
});

describe('renderDelegation (delegation ownership + status)', () => {
  const granted: DelegationContract = {
    parentTaskId: 'task-1',
    delegationId: 'deleg-1',
    objective: 'Read the three call sites',
    constraints: [],
    expectedOutput: [],
    allowedToolCapabilities: ['github:read'],
    deniedToolCapabilities: ['github:write'],
    resourceOwnership: ['fixture/src/cart.js'],
    evidenceRequirements: [],
    maxSteps: 5,
    maxDepth: 2,
    depth: 1,
  };

  test('renders a granted contract with ownership and depth', () => {
    const out = renderBlock(renderDelegation({ ok: true, contract: granted }));
    assert.match(out, /granted/);
    assert.match(out, /depth 1\/2/);
    assert.match(out, /Read the three call sites/);
    assert.match(out, /github:read/);
    assert.match(out, /fixture\/src\/cart\.js/);
    assert.match(out, /github:write/);
  });

  test('renders a typed denial with its code and reason', () => {
    const out = renderBlock(
      renderDelegation({
        ok: false,
        code: 'permission_widening',
        reason: 'Requested capabilities exceed parent authority: github:admin.',
      }),
    );
    assert.match(out, /denied/);
    assert.match(out, /permission_widening/);
    assert.match(out, /exceed parent authority/);
  });

  test('renderDelegationContract shows no-write-resources for an empty owner set', () => {
    const out = renderBlock(renderDelegationContract({ ...granted, resourceOwnership: [] }));
    assert.match(out, /no write resources/);
  });

  test('uses the stable kernel.delegation key', () => {
    assert.equal(renderDelegation({ ok: true, contract: granted }).key, 'kernel.delegation');
  });
});
