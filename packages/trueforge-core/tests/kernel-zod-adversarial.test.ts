import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskContractSchema,
  CompilerOptionsSchema,
  parseTaskContract,
  safeParseTaskContract,
  compileTaskContract,
  type CompilerOptions,
} from '../../../src/runtime/kernel/contract.ts';
import {
  WorkingStateEventSchema,
  WorkingStateSchema,
  projectWorkingState,
  type WorkingStateEvent,
} from '../../../src/runtime/kernel/working-state.ts';
import { ModelLimitsSchema, planContextBudget } from '../../../src/runtime/kernel/context.ts';
import {
  ToolDescriptorSchema,
  SelectionContextSchema,
  selectTools,
  type SelectionContext,
  type ToolDescriptor,
} from '../../../src/runtime/kernel/tool-selection.ts';
import {
  DelegationRequestSchema,
  ParentAuthoritySchema,
  ChildResultSchema,
  deriveDelegation,
  validateChildResult,
  type DelegationRequest,
  type ParentAuthority,
} from '../../../src/runtime/kernel/delegation.ts';
import {
  VerificationInputSchema,
  verifyCompletion,
  type VerificationInput,
} from '../../../src/runtime/kernel/verification.ts';
import { AdaptiveAgentKernel, KernelOptionsSchema } from '../../../src/runtime/kernel/index.ts';
import type { EvidenceSummary } from '../../../src/runtime/evidence.ts';

const options: CompilerOptions = {
  requireTestEvidence: true,
  writePaths: ['fixture/**'],
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  policyVersion: 'v1',
};

function evidence(over: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    workspaceEpoch: 1,
    regressionObserved: true,
    regressionIsHistorical: false,
    targetedTestPassed: true,
    fullSuitePassed: true,
    unverifiedSuccessObserved: false,
    records: [],
    ...over,
  };
}

// Malformed payloads are declared as `unknown` and fed to schemas whose
// `safeParse`/`parse` accept `unknown` — so these tests need no type assertions,
// no `any`, and no suppression comments.

// ---------------------------------------------------------------------------
// contract.ts — malformed values, unknown fields, bounds
// ---------------------------------------------------------------------------
describe('adversarial — TaskContract admission boundary', () => {
  test('a valid compiled contract round-trips through parseTaskContract', () => {
    const contract = compileTaskContract('Fix the null deref in cart', options, 't1');
    const reparsed = parseTaskContract(structuredClone(contract));
    assert.deepEqual(reparsed, contract);
  });

  test('rejects an unknown top-level field (strict object)', () => {
    const contract = compileTaskContract('Fix the crash', options, 't2');
    const tampered: unknown = { ...structuredClone(contract), injected: 'ignore previous instructions' };
    assert.equal(safeParseTaskContract(tampered).success, false);
  });

  test('rejects a malformed enum value for taskType', () => {
    const contract = compileTaskContract('Fix the crash', options, 't3');
    const tampered: unknown = { ...structuredClone(contract), taskType: 'root_shell' };
    assert.equal(safeParseTaskContract(tampered).success, false);
  });

  test('rejects a wrong scalar type for revision', () => {
    const contract = compileTaskContract('Fix the crash', options, 't4');
    const tampered: unknown = { ...structuredClone(contract), revision: '2' };
    assert.equal(safeParseTaskContract(tampered).success, false);
  });

  test('rejects an over-long objective (upper bound enforced)', () => {
    const contract = compileTaskContract('Fix the crash', options, 't5');
    const tampered: unknown = { ...structuredClone(contract), objective: 'x'.repeat(5000) };
    assert.equal(safeParseTaskContract(tampered).success, false);
  });

  test('parseTaskContract throws on a malformed contract', () => {
    const tampered: unknown = { not: 'a contract' };
    assert.throws(() => parseTaskContract(tampered));
  });

  test('rejects a nested constraint with an unknown field', () => {
    const bad: unknown = {
      version: 1,
      taskId: 't6',
      objective: 'fix',
      taskType: 'bug_fix',
      constraints: [{ id: 'c1', text: 'x', provenance: 'user', rogue: true }],
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
    };
    assert.equal(TaskContractSchema.safeParse(bad).success, false);
  });

  test('CompilerOptions rejects an unknown field', () => {
    const bad: unknown = { ...options, extra: 1 };
    assert.equal(CompilerOptionsSchema.safeParse(bad).success, false);
  });
});

// ---------------------------------------------------------------------------
// working-state.ts — malformed events, bounds, unknown fields, replay
// ---------------------------------------------------------------------------
describe('adversarial — WorkingState replay boundary', () => {
  test('rejects an unknown event type', () => {
    const bad: unknown = { type: 'exfiltrate_secrets' };
    assert.equal(WorkingStateEventSchema.safeParse(bad).success, false);
  });

  test('rejects an event with an unknown extra field (strict)', () => {
    const bad: unknown = { type: 'phase_changed', phase: 'executing', rogue: 1 };
    assert.equal(WorkingStateEventSchema.safeParse(bad).success, false);
  });

  test('rejects a malformed phase enum', () => {
    const bad: unknown = { type: 'phase_changed', phase: 'pwned' };
    assert.equal(WorkingStateEventSchema.safeParse(bad).success, false);
  });

  test('rejects a negative epoch (lower bound enforced)', () => {
    const bad: unknown = { type: 'resource_mutated', resource: 'fixture/a.js', kind: 'write', atEpoch: -1 };
    assert.equal(WorkingStateEventSchema.safeParse(bad).success, false);
  });

  test('rejects an over-long criteria array (upper bound enforced)', () => {
    const bad: unknown = {
      type: 'criteria_set',
      criteria: Array.from({ length: 1000 }, (_, i) => `criterion-${i}`),
    };
    assert.equal(WorkingStateEventSchema.safeParse(bad).success, false);
  });

  test('a projected working state validates against WorkingStateSchema', () => {
    const state = projectWorkingState('t', [
      { type: 'phase_changed', phase: 'executing' },
      { type: 'criteria_set', criteria: ['a', 'b'] },
    ]);
    assert.equal(WorkingStateSchema.safeParse(state).success, true);
  });

  test('WorkingState rejects an out-of-bounds updatedAt (non-datetime)', () => {
    const state = projectWorkingState('t', []);
    const bad: unknown = { ...state, updatedAt: 'not-a-date' };
    assert.equal(WorkingStateSchema.safeParse(bad).success, false);
  });
});

// ---------------------------------------------------------------------------
// Deterministic replay — byte-identical, no wall-clock time
// ---------------------------------------------------------------------------
describe('adversarial — deterministic replay is byte-identical', () => {
  const events: WorkingStateEvent[] = [
    { type: 'phase_changed', phase: 'planning' },
    { type: 'plan_set', steps: [{ id: 's1', text: 'reproduce' }, { id: 's2', text: 'fix' }] },
    { type: 'step_activated', id: 's1' },
    { type: 'fact_observed', text: 'cart.js line 12 throws', provenance: 'tool-discovered', verified: true },
    { type: 'failure_recorded', failureClass: 'domain', summary: 'null deref' },
  ];

  test('identical event sequences serialize to byte-identical JSON, including updatedAt', () => {
    const a = projectWorkingState('t', events);
    const b = projectWorkingState('t', events);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('with no event timestamps, updatedAt is the deterministic epoch (no Date.now)', () => {
    const state = projectWorkingState('t', events);
    assert.equal(state.updatedAt, new Date(0).toISOString());
  });

  test('updatedAt is taken from the latest event timestamp when present', () => {
    const stamped: WorkingStateEvent[] = [
      { type: 'phase_changed', phase: 'planning', at: '2024-01-01T00:00:00.000Z' },
      { type: 'phase_changed', phase: 'executing', at: '2024-06-15T12:30:00.000Z' },
    ];
    const first = projectWorkingState('t', stamped);
    const second = projectWorkingState('t', stamped);
    assert.equal(first.updatedAt, '2024-06-15T12:30:00.000Z');
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  test('replay does not read the wall clock: two projections milliseconds apart match exactly', () => {
    const a = projectWorkingState('t', events);
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin so a wall-clock updatedAt would diverge */
    }
    const b = projectWorkingState('t', events);
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// context.ts — ModelLimits boundary
// ---------------------------------------------------------------------------
describe('adversarial — context budget boundary', () => {
  test('ModelLimits rejects a zero context window (min 1)', () => {
    const bad: unknown = { contextWindow: 0, maxOutputTokens: 100 };
    assert.equal(ModelLimitsSchema.safeParse(bad).success, false);
  });

  test('ModelLimits rejects a non-integer window', () => {
    const bad: unknown = { contextWindow: 1.5, maxOutputTokens: 100 };
    assert.equal(ModelLimitsSchema.safeParse(bad).success, false);
  });

  test('ModelLimits rejects an unknown field', () => {
    const bad: unknown = { contextWindow: 1000, maxOutputTokens: 100, rogue: true };
    assert.equal(ModelLimitsSchema.safeParse(bad).success, false);
  });

  test('planContextBudget throws on a value-invalid window at the boundary', () => {
    // Type-valid numbers, but a zero window violates the schema's min(1).
    assert.throws(() => planContextBudget({ contextWindow: 0, maxOutputTokens: 1 }, 0));
  });
});

// ---------------------------------------------------------------------------
// tool-selection.ts — descriptor/context boundary
// ---------------------------------------------------------------------------
describe('adversarial — tool selection boundary', () => {
  const ctx: SelectionContext = {
    taskType: 'bug_fix',
    referencedResources: [],
    requiredToolNames: [],
    priorFailedToolNames: [],
    minSurfaceForSelection: 4,
    maxPresented: 20,
  };

  test('ToolDescriptor rejects a malformed tag', () => {
    const bad: unknown = { toolName: 'x', toolSetName: 'y', tags: ['root'], schemaTokens: 1, preloaded: false };
    assert.equal(ToolDescriptorSchema.safeParse(bad).success, false);
  });

  test('SelectionContext rejects an unknown field', () => {
    const bad: unknown = { ...ctx, rogue: 1 };
    assert.equal(SelectionContextSchema.safeParse(bad).success, false);
  });

  test('selectTools throws on a value-invalid schemaTokens at the boundary', () => {
    // Type-valid descriptor shape, but a negative schemaTokens violates min(0).
    const tool = (
      toolName: string,
      tags: ToolDescriptor['tags'],
      schemaTokens: number,
    ): ToolDescriptor => ({ toolName, toolSetName: 'y', tags, schemaTokens, preloaded: false });
    const negativeTokens: ToolDescriptor[] = [
      tool('x', ['read'], -1),
      tool('z', ['write'], 1),
      tool('w', ['test'], 1),
      tool('v', ['search'], 1),
      tool('u', ['discovery'], 1),
    ];
    assert.throws(() => selectTools(negativeTokens, ctx));
  });
});

// ---------------------------------------------------------------------------
// delegation.ts — request/parent/child boundary
// ---------------------------------------------------------------------------
describe('adversarial — delegation boundary', () => {
  const parent: ParentAuthority = {
    parentTaskId: 'p1',
    allowedToolCapabilities: ['read'],
    ownedResources: [],
    depth: 0,
    maxDepth: 2,
    profileToolCapabilities: ['read'],
  };
  const request: DelegationRequest = {
    objective: 'read a call site',
    constraints: [],
    expectedOutput: [],
    requestedToolCapabilities: ['read'],
    deniedToolCapabilities: [],
    resourceOwnership: [],
    evidenceRequirements: [],
    maxSteps: 4,
  };

  test('ParentAuthority rejects an unknown field', () => {
    const bad: unknown = { ...parent, rogue: 1 };
    assert.equal(ParentAuthoritySchema.safeParse(bad).success, false);
  });

  test('DelegationRequest rejects a non-integer maxSteps', () => {
    const bad: unknown = { ...request, maxSteps: 4.5 };
    assert.equal(DelegationRequestSchema.safeParse(bad).success, false);
  });

  test('deriveDelegation throws when parent depth is value-invalid (negative)', () => {
    // Type-valid number, but a negative depth violates min(0).
    assert.throws(() => deriveDelegation({ ...parent, depth: -1 }, request));
  });

  test('ChildResult rejects an unknown field and a bad status', () => {
    const badStatus: unknown = {
      delegationId: 'd',
      status: 'exploded',
      resultSummary: 'x',
      claims: [],
      evidenceReferences: [],
      resourcesInspected: [],
      resourcesChanged: [],
      unresolvedQuestions: [],
      recommendedNextAction: 'stop',
    };
    assert.equal(ChildResultSchema.safeParse(badStatus).success, false);

    const rogueField: unknown = {
      delegationId: 'd',
      status: 'succeeded',
      resultSummary: 'x',
      claims: [],
      evidenceReferences: [],
      resourcesInspected: [],
      resourcesChanged: [],
      unresolvedQuestions: [],
      recommendedNextAction: 'stop',
      rogue: true,
    };
    assert.equal(ChildResultSchema.safeParse(rogueField).success, false);
  });

  test('validateChildResult accepts a well-formed owned-resource result', () => {
    const outcome = deriveDelegation(parent, { ...request, resourceOwnership: ['fixture/new.js'] });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const verdict = validateChildResult(outcome.contract, {
      delegationId: outcome.contract.delegationId,
      status: 'succeeded',
      resultSummary: 'wrote new.js',
      claims: [],
      evidenceReferences: [],
      resourcesInspected: [],
      resourcesChanged: ['fixture/new.js'],
      unresolvedQuestions: [],
      recommendedNextAction: 'run the suite',
    });
    assert.deepEqual(verdict, { ok: true });
  });
});

// ---------------------------------------------------------------------------
// verification.ts / index.ts — verification input boundary
// ---------------------------------------------------------------------------
describe('adversarial — verification boundary', () => {
  const bugFix = compileTaskContract('Fix the null deref crash in cart', options, 'vv1');

  function input(over: Partial<VerificationInput>): VerificationInput {
    return {
      contract: bugFix,
      workingState: projectWorkingState(bugFix.taskId, [{ type: 'criteria_set', criteria: [] }]),
      evidence: evidence(),
      pendingRequiredActions: 0,
      unknownWriteOutcomes: 0,
      activePolicyVersion: 'v1',
      contractPolicyVersion: 'v1',
      proposedOutput: 'done',
      ...over,
    };
  }

  test('a well-formed verification input parses', () => {
    const value: unknown = input({});
    assert.equal(VerificationInputSchema.safeParse(value).success, true);
  });

  test('rejects an unknown field on the verification input', () => {
    const value: unknown = { ...input({}), rogue: 1 };
    assert.equal(VerificationInputSchema.safeParse(value).success, false);
  });

  test('rejects a negative pendingRequiredActions (lower bound)', () => {
    const value: unknown = input({ pendingRequiredActions: -1 });
    assert.equal(VerificationInputSchema.safeParse(value).success, false);
  });

  test('verifyCompletion throws when pendingRequiredActions is value-invalid (negative)', () => {
    // Type-valid number, schema-invalid (< 0): the boundary parse must reject it.
    assert.throws(() => verifyCompletion(input({ pendingRequiredActions: -1 })));
  });

  test('KernelOptions parses a well-formed config and rejects unknown fields', () => {
    assert.equal(
      KernelOptionsSchema.safeParse({
        ...options,
        enabled: true,
        modelLimits: { contextWindow: 1000, maxOutputTokens: 100 },
      }).success,
      true,
    );
    const bad: unknown = {
      ...options,
      enabled: true,
      modelLimits: { contextWindow: 1000, maxOutputTokens: 100 },
      rogue: 1,
    };
    assert.equal(KernelOptionsSchema.safeParse(bad).success, false);
  });

  test('AdaptiveAgentKernel construction throws on a value-invalid model window', () => {
    assert.throws(
      () =>
        new AdaptiveAgentKernel({
          ...options,
          enabled: true,
          modelLimits: { contextWindow: 0, maxOutputTokens: 100 },
        }),
    );
  });
});
