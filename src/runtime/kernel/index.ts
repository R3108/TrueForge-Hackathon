/**
 * Adaptive Agent Kernel — live-path coordinator.
 *
 * Ties the deterministic pieces together and exposes them to the incident loop
 * in `run.ts` without changing any existing policy or protocol behavior. It:
 *   - compiles a durable, versioned TaskContract (bypassing simple questions),
 *   - maintains an event-derived WorkingState projection,
 *   - plans a deterministic context budget and ordered prompt sections,
 *   - verifies proposed completion and rewrites false success for action tasks,
 *   - emits additive informational events keyed by fixed-core reserved
 *     capability_state keys.
 *
 * It is additive: when disabled (or for bypassed questions) it does not alter
 * the turn. Reserved keys and event types are stable so clients that ignore
 * them stay compatible.
 */

import {
  compileTaskContract,
  reviseContract,
  CompilerOptionsSchema,
  type TaskContract,
} from './contract.ts';
import {
  projectWorkingState,
  projectForModel,
  type WorkingState,
  type WorkingStateEvent,
} from './working-state.ts';
import {
  assemblePrompt,
  debugPrompt,
  makeSection,
  planContextBudget,
  estimateTokens,
  ModelLimitsSchema,
  type ContextBudgetPlan,
  type PromptSection,
} from './context.ts';
import {
  verifyCompletion,
  type CompletionDecision,
  type VerificationInput,
} from './verification.ts';
import type { EvidenceSummary } from '../evidence.ts';
import { z } from 'zod';
import { LIMITS, boundedArray, boundedInt, idString, shortText } from './schema.ts';

/**
 * Fixed-core reserved capability_state keys. These names are stable and additive;
 * consumers key off them and may ignore unknown future keys. The key VALUES are
 * a Zod-owned enum so the reserved surface is validated like any other contract.
 */
export const CapabilityStateKeySchema = z.enum([
  'kernel.task_contract',
  'kernel.working_state',
  'kernel.context_plan',
  'kernel.verification',
  'kernel.tool_selection',
  'kernel.delegation',
]);
export type CapabilityStateKey = z.infer<typeof CapabilityStateKeySchema>;

export const CAPABILITY_STATE_KEYS: {
  readonly taskContract: CapabilityStateKey;
  readonly workingState: CapabilityStateKey;
  readonly contextPlan: CapabilityStateKey;
  readonly verification: CapabilityStateKey;
  readonly toolSelection: CapabilityStateKey;
  readonly delegation: CapabilityStateKey;
} = {
  taskContract: 'kernel.task_contract',
  workingState: 'kernel.working_state',
  contextPlan: 'kernel.context_plan',
  verification: 'kernel.verification',
  toolSelection: 'kernel.tool_selection',
  delegation: 'kernel.delegation',
};

/** Additive informational event types. Never required-action types. */
export const KernelEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('task.contract_created'),
    taskId: idString,
    revision: boundedInt(),
    taskType: shortText,
    bypassed: z.boolean(),
  }),
  z.strictObject({ type: z.literal('task.contract_updated'), taskId: idString, revision: boundedInt() }),
  z.strictObject({
    type: z.literal('task.contract_blocked'),
    taskId: idString,
    reasons: boundedArray(shortText, LIMITS.smallArray),
  }),
  z.strictObject({ type: z.literal('task.contract_satisfied'), taskId: idString }),
  z.strictObject({ type: z.literal('task.state_updated'), taskId: idString, phase: shortText }),
  z.strictObject({
    type: z.literal('context.plan_created'),
    contextWindow: boundedInt(),
    pinnedBudget: boundedInt(),
  }),
  z.strictObject({
    type: z.literal('verification.updated'),
    status: z.enum(['satisfied', 'incomplete']),
    blocking: boundedInt(),
  }),
]);
export type KernelEvent = z.infer<typeof KernelEventSchema>;

export const KernelOptionsSchema = CompilerOptionsSchema.extend({
  enabled: z.boolean(),
  modelLimits: ModelLimitsSchema,
});
export type KernelOptions = z.infer<typeof KernelOptionsSchema>;

export const KernelMetricsSchema = z.strictObject({
  requestCompilations: boundedInt(),
  contractRevisions: boundedInt(),
  falseCompletionsBlocked: boundedInt(),
  verificationsRun: boundedInt(),
});
export type KernelMetrics = z.infer<typeof KernelMetricsSchema>;

/**
 * Per-incident kernel instance. Deterministic and side-effect free apart from
 * appending to its own durable event/working-state logs.
 */
export class AdaptiveAgentKernel {
  readonly #options: KernelOptions;
  readonly #events: KernelEvent[] = [];
  readonly #stateEvents: WorkingStateEvent[] = [];
  #contract: TaskContract | undefined;
  #metrics: KernelMetrics = {
    requestCompilations: 0,
    contractRevisions: 0,
    falseCompletionsBlocked: 0,
    verificationsRun: 0,
  };

  constructor(options: KernelOptions) {
    this.#options = KernelOptionsSchema.parse(options);
  }

  get enabled(): boolean {
    return this.#options.enabled;
  }

  get contract(): TaskContract | undefined {
    return this.#contract;
  }

  get events(): readonly KernelEvent[] {
    return this.#events;
  }

  get metrics(): KernelMetrics {
    return this.#metrics;
  }

  /** Compile (or bypass) the incoming brief into a durable contract. */
  admit(brief: string, taskId: string): TaskContract {
    const contract = compileTaskContract(brief, this.#options, taskId);
    this.#metrics.requestCompilations += 1;
    this.#contract = contract;
    this.#stateEvents.push({ type: 'contract_bound', contract });
    this.#stateEvents.push({ type: 'criteria_set', criteria: contract.acceptanceCriteria.map((c) => c.text) });
    this.#events.push({
      type: 'task.contract_created',
      taskId,
      revision: contract.revision,
      taskType: contract.taskType,
      bypassed: contract.bypassed,
    });
    if (contract.status === 'blocked') {
      this.#events.push({
        type: 'task.contract_blocked',
        taskId,
        reasons: contract.ambiguities.filter((a) => a.blocking).map((a) => a.text),
      });
    }
    return contract;
  }

  /** Apply a user correction as a new contract revision (history preserved). */
  applyCorrection(correction: string): TaskContract {
    if (!this.#contract) throw new Error('No contract to revise.');
    const revised = reviseContract(this.#contract, correction, this.#options);
    this.#contract = revised;
    this.#metrics.contractRevisions += 1;
    this.#stateEvents.push({ type: 'contract_bound', contract: revised });
    this.#events.push({ type: 'task.contract_updated', taskId: revised.taskId, revision: revised.revision });
    return revised;
  }

  /** Record a durable working-state event. Ignored for bypassed questions. */
  recordState(event: WorkingStateEvent): void {
    if (this.#contract?.bypassed) return;
    this.#stateEvents.push(event);
    if (event.type === 'phase_changed' && this.#contract) {
      this.#events.push({ type: 'task.state_updated', taskId: this.#contract.taskId, phase: event.phase });
    }
  }

  /** The current working-state projection, rebuilt from durable events. */
  workingState(): WorkingState {
    return projectWorkingState(this.#contract?.taskId ?? 'unknown', this.#stateEvents);
  }

  /** Deterministic context budget plan for the configured model limits. */
  contextPlan(): ContextBudgetPlan {
    const pinned = estimateTokens(this.pinnedContext());
    const plan = planContextBudget(this.#options.modelLimits, pinned);
    this.#events.push({
      type: 'context.plan_created',
      contextWindow: plan.contextWindow,
      pinnedBudget: plan.pinnedBudget,
    });
    return plan;
  }

  /** The concise, provenance-tagged pinned context injected into the model. */
  pinnedContext(): string {
    if (!this.#contract) return '';
    return assemblePrompt(this.pinnedSections());
  }

  pinnedSections(): PromptSection[] {
    const contract = this.#contract;
    if (!contract) return [];
    const sections: PromptSection[] = [
      makeSection('task-objective', 'task-contract', `Objective: ${contract.objective}\nType: ${contract.taskType}\nRevision: ${contract.revision}`),
    ];
    const userConstraints = contract.constraints.filter((c) => c.provenance === 'user');
    if (userConstraints.length > 0) {
      sections.push(
        makeSection('user-constraints', 'task-contract', userConstraints.map((c) => `- ${c.text}`).join('\n')),
      );
    }
    const policyConstraints = contract.constraints.filter((c) => c.provenance === 'policy');
    if (policyConstraints.length > 0) {
      sections.push(
        makeSection('policy-constraints', 'core-policy', policyConstraints.map((c) => `- ${c.text}`).join('\n')),
      );
    }
    const ws = this.workingState();
    const wsProjection = projectForModel(ws);
    if (wsProjection.trim().length > 0) {
      sections.push(makeSection('working-state', 'working-state', wsProjection));
    }
    if (contract.requiredEvidence.length > 0) {
      sections.push(
        makeSection(
          'verification-requirements',
          'verification',
          contract.requiredEvidence.map((e) => `- ${e.description}`).join('\n'),
        ),
      );
    }
    return sections;
  }

  /** Inspectable, secret-free view of the pinned context. */
  debugPinned(): ReturnType<typeof debugPrompt> {
    return debugPrompt(this.pinnedSections());
  }

  /**
   * Verify a proposed final output. For action tasks a claimed success without
   * the required verified evidence is blocked and rewritten truthfully.
   */
  verify(
    proposedOutput: string,
    evidence: EvidenceSummary,
    pendingRequiredActions: number,
    unknownWriteOutcomes: number,
  ): CompletionDecision {
    const contract = this.#contract;
    if (!contract) {
      return { satisfied: true, output: proposedOutput, falseCompletionBlocked: false, results: [], blockingReasons: [] };
    }
    const input: VerificationInput = {
      contract,
      workingState: this.workingState(),
      evidence,
      pendingRequiredActions,
      unknownWriteOutcomes,
      activePolicyVersion: this.#options.policyVersion,
      contractPolicyVersion: contract.policyVersion,
      proposedOutput,
    };
    const decision = verifyCompletion(input);
    this.#metrics.verificationsRun += 1;
    if (decision.falseCompletionBlocked) this.#metrics.falseCompletionsBlocked += 1;
    this.#events.push({
      type: 'verification.updated',
      status: decision.satisfied ? 'satisfied' : 'incomplete',
      blocking: decision.blockingReasons.length,
    });
    if (decision.satisfied) {
      this.#events.push({ type: 'task.contract_satisfied', taskId: contract.taskId });
    }
    return decision;
  }
}
