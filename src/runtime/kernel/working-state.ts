/**
 * Phase 2 — Durable WorkingState projection.
 *
 * WorkingState is a concise, event-derived projection of externally useful
 * progress. It is rebuilt by folding an append-only sequence of {@link WorkingStateEvent}s,
 * so a restart reconstructs identical state. It deliberately stores no hidden
 * chain-of-thought, no raw secrets, no full command output, and no full
 * repository content — only typed facts, digests, and locators.
 *
 * Every observed fact carries provenance; model inference is never silently
 * promoted to a verified fact.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProvenanceSchema, TaskContractSchema } from './contract.ts';
import { LIMITS, boundedArray, boundedInt, idString, isoDateTime, shortText, text } from './schema.ts';

export const PhaseSchema = z.enum([
  'understanding',
  'retrieving',
  'planning',
  'executing',
  'verifying',
  'blocked',
  'complete',
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const PlanStepStatusSchema = z.enum(['pending', 'active', 'done', 'abandoned']);

export const PlanStepSchema = z.strictObject({
  id: idString,
  text: shortText,
  status: PlanStepStatusSchema,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ObservedFactSchema = z.strictObject({
  id: idString,
  text: shortText,
  provenance: ProvenanceSchema,
  verified: z.boolean(),
});
export type ObservedFact = z.infer<typeof ObservedFactSchema>;

export const ResourceMutationKindSchema = z.enum(['write', 'delete', 'create']);

export const ResourceMutationSchema = z.strictObject({
  resource: shortText,
  kind: ResourceMutationKindSchema,
  atEpoch: boundedInt(),
});
export type ResourceMutation = z.infer<typeof ResourceMutationSchema>;

export const AttemptOutcomeSchema = z.enum(['succeeded', 'failed', 'abandoned']);

export const AttemptSummarySchema = z.strictObject({
  id: idString,
  approach: shortText,
  outcome: AttemptOutcomeSchema,
});
export type AttemptSummary = z.infer<typeof AttemptSummarySchema>;

export const StructuredFailureSchema = z.strictObject({
  id: idString,
  failureClass: shortText,
  summary: shortText,
  resolved: z.boolean(),
});
export type StructuredFailure = z.infer<typeof StructuredFailureSchema>;

export const EvidenceLocatorSchema = z.strictObject({
  id: idString,
  kind: shortText,
  digest: shortText.optional(),
  locator: shortText.optional(),
  atEpoch: boundedInt(),
});
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

export const WorkingStateSchema = z.strictObject({
  taskId: idString,
  contractRevision: boundedInt(),
  phase: PhaseSchema,
  plan: boundedArray(PlanStepSchema, LIMITS.smallArray),
  activeStepIds: boundedArray(idString, LIMITS.smallArray),
  observedFacts: boundedArray(ObservedFactSchema, LIMITS.mediumArray),
  touchedResources: boundedArray(ResourceMutationSchema, LIMITS.mediumArray),
  attemptedApproaches: boundedArray(AttemptSummarySchema, LIMITS.mediumArray),
  unresolvedErrors: boundedArray(StructuredFailureSchema, LIMITS.mediumArray),
  evidence: boundedArray(EvidenceLocatorSchema, LIMITS.mediumArray),
  remainingCriteria: boundedArray(shortText, LIMITS.smallArray),
  updatedAt: isoDateTime,
});
export type WorkingState = z.infer<typeof WorkingStateSchema>;

const SECRET_HINT = /(secret|token|password|api[_-]?key|credential|authorization|bearer|-----BEGIN)/i;
const REASONING_HINT = /(let me think|chain of thought|reasoning:|i think that|my thought)/i;

/** Reject text that looks like a raw secret or hidden reasoning trace. */
export function isPersistableText(text: string): boolean {
  return !SECRET_HINT.test(text) && !REASONING_HINT.test(text);
}

/** Reduce free text to a bounded, redacted, single-line summary. */
export function redactSummary(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const redacted = collapsed.replace(
    /(secret|token|password|api[_-]?key|credential|bearer)\S*/gi,
    '$1[redacted]',
  );
  return redacted.slice(0, max);
}

export function digestOf(value: unknown): string {
  const material = typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Optional deterministic event timestamp. When present it is folded into
 * {@link WorkingState.updatedAt}; identical event sequences therefore project a
 * byte-identical `updatedAt`. Wall-clock time is never read during projection.
 */
const eventTimestamp = isoDateTime.optional();

export const WorkingStateEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('contract_bound'), contract: TaskContractSchema, at: eventTimestamp }),
  z.strictObject({ type: z.literal('phase_changed'), phase: PhaseSchema, at: eventTimestamp }),
  z.strictObject({
    type: z.literal('plan_set'),
    steps: boundedArray(z.strictObject({ id: idString, text: text }), LIMITS.smallArray),
    at: eventTimestamp,
  }),
  z.strictObject({ type: z.literal('step_activated'), id: idString, at: eventTimestamp }),
  z.strictObject({ type: z.literal('step_completed'), id: idString, at: eventTimestamp }),
  z.strictObject({ type: z.literal('step_abandoned'), id: idString, at: eventTimestamp }),
  z.strictObject({
    type: z.literal('fact_observed'),
    text: text,
    provenance: ProvenanceSchema,
    verified: z.boolean(),
    at: eventTimestamp,
  }),
  z.strictObject({
    type: z.literal('resource_mutated'),
    resource: shortText,
    kind: ResourceMutationKindSchema,
    atEpoch: boundedInt(),
    at: eventTimestamp,
  }),
  z.strictObject({
    type: z.literal('approach_attempted'),
    approach: text,
    outcome: AttemptOutcomeSchema,
    at: eventTimestamp,
  }),
  z.strictObject({
    type: z.literal('failure_recorded'),
    failureClass: shortText,
    summary: text,
    at: eventTimestamp,
  }),
  z.strictObject({ type: z.literal('failure_resolved'), id: idString, at: eventTimestamp }),
  z.strictObject({
    type: z.literal('evidence_recorded'),
    kind: shortText,
    digest: shortText.optional(),
    locator: shortText.optional(),
    atEpoch: boundedInt(),
    at: eventTimestamp,
  }),
  z.strictObject({ type: z.literal('criteria_set'), criteria: boundedArray(shortText, LIMITS.smallArray), at: eventTimestamp }),
  z.strictObject({ type: z.literal('criterion_satisfied'), text: shortText, at: eventTimestamp }),
]);
export type WorkingStateEvent = z.infer<typeof WorkingStateEventSchema>;

// Deterministic per-projection id: derived from the event's ordinal index so
// replaying the same event sequence reconstructs byte-identical ids.
function deterministicId(prefix: string, index: number): string {
  return `${prefix}-${index.toString(36)}`;
}

/** Deterministic fallback timestamp used when no event supplies one. */
const DETERMINISTIC_EPOCH = new Date(0).toISOString();

function emptyState(taskId: string): WorkingState {
  return {
    taskId,
    contractRevision: 0,
    phase: 'understanding',
    plan: [],
    activeStepIds: [],
    observedFacts: [],
    touchedResources: [],
    attemptedApproaches: [],
    unresolvedErrors: [],
    evidence: [],
    remainingCriteria: [],
    updatedAt: DETERMINISTIC_EPOCH,
  };
}

/**
 * Fold an event sequence into a WorkingState. Deterministic and side-effect free
 * (no wall-clock read, monotonic id generation only), so replaying the same
 * event sequence reconstructs byte-identical state — including `updatedAt`,
 * which is taken from the latest event that carries a timestamp, or the
 * deterministic epoch fallback when none do.
 *
 * Events are validated at this replay boundary; a malformed, out-of-bounds, or
 * unknown-field event is rejected (fail closed) rather than silently folded.
 */
export function projectWorkingState(
  taskId: string,
  events: readonly WorkingStateEvent[],
): WorkingState {
  const parsedEvents = z.array(WorkingStateEventSchema).parse(events);
  const state = emptyState(taskId);
  let latestTimestamp: string | undefined;

  for (const [index, event] of parsedEvents.entries()) {
    if (event.at !== undefined) latestTimestamp = event.at;
    switch (event.type) {
      case 'contract_bound': {
        state.contractRevision = event.contract.revision;
        state.remainingCriteria = event.contract.acceptanceCriteria.map((c) => c.text);
        break;
      }
      case 'phase_changed':
        state.phase = event.phase;
        break;
      case 'plan_set':
        state.plan = event.steps.map((s) => ({ id: s.id, text: redactSummary(s.text), status: 'pending' }));
        state.activeStepIds = [];
        break;
      case 'step_activated': {
        const step = state.plan.find((s) => s.id === event.id);
        if (step) step.status = 'active';
        if (!state.activeStepIds.includes(event.id)) state.activeStepIds.push(event.id);
        break;
      }
      case 'step_completed': {
        const step = state.plan.find((s) => s.id === event.id);
        if (step) step.status = 'done';
        state.activeStepIds = state.activeStepIds.filter((id) => id !== event.id);
        break;
      }
      case 'step_abandoned': {
        const step = state.plan.find((s) => s.id === event.id);
        if (step) step.status = 'abandoned';
        state.activeStepIds = state.activeStepIds.filter((id) => id !== event.id);
        break;
      }
      case 'fact_observed': {
        if (!isPersistableText(event.text)) break;
        // Model/harness inference is never promoted to a verified fact.
        const verified = event.provenance === 'harness-inferred' ? false : event.verified;
        state.observedFacts.push({
          id: deterministicId('fact', index),
          text: redactSummary(event.text),
          provenance: event.provenance,
          verified,
        });
        break;
      }
      case 'resource_mutated':
        state.touchedResources.push({ resource: event.resource, kind: event.kind, atEpoch: event.atEpoch });
        break;
      case 'approach_attempted':
        state.attemptedApproaches.push({
          id: deterministicId('att', index),
          approach: redactSummary(event.approach),
          outcome: event.outcome,
        });
        break;
      case 'failure_recorded':
        state.unresolvedErrors.push({
          id: deterministicId('fail', index),
          failureClass: event.failureClass,
          summary: redactSummary(event.summary),
          resolved: false,
        });
        break;
      case 'failure_resolved': {
        const failure = state.unresolvedErrors.find((f) => f.id === event.id);
        if (failure) failure.resolved = true;
        break;
      }
      case 'evidence_recorded':
        state.evidence.push({
          id: deterministicId('ev', index),
          kind: event.kind,
          digest: event.digest,
          locator: event.locator,
          atEpoch: event.atEpoch,
        });
        break;
      case 'criteria_set':
        state.remainingCriteria = [...event.criteria];
        break;
      case 'criterion_satisfied':
        state.remainingCriteria = state.remainingCriteria.filter((c) => c !== event.text);
        break;
    }
  }

  state.updatedAt = latestTimestamp ?? DETERMINISTIC_EPOCH;
  return WorkingStateSchema.parse(state);
}

/**
 * Concise, model-facing projection generated from durable state. It preserves
 * unresolved work, blockers, remaining criteria, and failed approaches so
 * compaction cannot cause repeated mistakes.
 */
export function projectForModel(state: WorkingState): string {
  const lines: string[] = [];
  lines.push(`Phase: ${state.phase}`);
  if (state.plan.length > 0) {
    lines.push('Plan:');
    for (const step of state.plan) lines.push(`  [${step.status}] ${step.text}`);
  }
  const unresolved = state.unresolvedErrors.filter((f) => !f.resolved);
  if (unresolved.length > 0) {
    lines.push('Unresolved errors:');
    for (const f of unresolved) lines.push(`  (${f.failureClass}) ${f.summary}`);
  }
  const failedApproaches = state.attemptedApproaches.filter((a) => a.outcome !== 'succeeded');
  if (failedApproaches.length > 0) {
    lines.push('Do not repeat these failed approaches:');
    for (const a of failedApproaches) lines.push(`  - ${a.approach} (${a.outcome})`);
  }
  if (state.remainingCriteria.length > 0) {
    lines.push('Remaining acceptance criteria:');
    for (const c of state.remainingCriteria) lines.push(`  - ${c}`);
  }
  if (state.evidence.length > 0) {
    lines.push(`Evidence records: ${state.evidence.length} (typed locators/digests only).`);
  }
  return lines.join('\n');
}
