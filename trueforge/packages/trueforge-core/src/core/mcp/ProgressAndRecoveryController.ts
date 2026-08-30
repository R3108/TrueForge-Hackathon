import { z } from 'zod';
import { EventType, type ToolExecutionLifecycleEvent } from '../events/schema';
import type { ToolExecutionOutcome } from './ToolExecutionCoordinator';

export const ToolRecoveryDispositionSchema = z.enum([
  'not_dispatched',
  'retry',
  'reconciliation_required',
  'terminal',
  'manual_review',
]);

export const ToolRecoveryDecisionSchema = z.object({
  tool_call_id: z.string(),
  thread_id: z.string(),
  attempt_id: z.string().nullable(),
  disposition: ToolRecoveryDispositionSchema,
  automatic_retry_allowed: z.boolean(),
  completion_unknown: z.boolean(),
  attempts_observed: z.number().int().nonnegative(),
  reason: z.string(),
});

export type ToolRecoveryDisposition = z.infer<typeof ToolRecoveryDispositionSchema>;
export type ToolRecoveryDecision = z.infer<typeof ToolRecoveryDecisionSchema>;

interface AttemptEvidence {
  prepared: Extract<ToolExecutionLifecycleEvent, { type: 'tool.prepared' }> | undefined;
  started: Extract<ToolExecutionLifecycleEvent, { type: 'tool.attempt_started' }> | undefined;
  completed: Extract<ToolExecutionLifecycleEvent, { type: 'tool.attempt_completed' }> | undefined;
}

function canRetryUnknownAttempt(evidence: AttemptEvidence, attemptsObserved: number, maxAttempts: number): boolean {
  return (
    evidence.prepared?.capability.side_effect_class === 'read_only' &&
    evidence.prepared.capability.retry_capability === 'safe' &&
    attemptsObserved < maxAttempts
  );
}

/**
 * Host-owned bounded retry and restart classification. It never reconstructs arguments or dispatches
 * writes: callers may retry only an in-memory read attempt, while persisted ambiguous writes require
 * an explicit reconciliation adapter or human review.
 */
export class ProgressAndRecoveryController {
  private readonly maxAttempts: number;

  constructor(options: { max_attempts?: number | undefined } = {}) {
    this.maxAttempts = z
      .number()
      .int()
      .min(1)
      .max(10)
      .parse(options.max_attempts ?? 2);
  }

  shouldRetry(options: { outcome: ToolExecutionOutcome; attempts_started: number }): boolean {
    const { outcome } = options;
    if (options.attempts_started >= this.maxAttempts) {
      return false;
    }
    if (outcome.status !== 'failed') {
      return false;
    }
    if (outcome.capability.side_effect_class !== 'read_only' || outcome.capability.retry_capability !== 'safe') {
      return false;
    }
    return (
      outcome.failure_class === 'transport_before_dispatch' || outcome.failure_class === 'transport_after_dispatch'
    );
  }

  classifyPersisted(events: readonly ToolExecutionLifecycleEvent[]): ReadonlyMap<string, ToolRecoveryDecision> {
    const byCall = new Map<string, Map<string, AttemptEvidence>>();
    const callOrder: string[] = [];

    for (const event of events) {
      let attempts = byCall.get(event.tool_call_id);
      if (attempts === undefined) {
        attempts = new Map<string, AttemptEvidence>();
        byCall.set(event.tool_call_id, attempts);
        callOrder.push(event.tool_call_id);
      }
      const evidence = attempts.get(event.attempt_id) ?? {
        prepared: undefined,
        started: undefined,
        completed: undefined,
      };
      if (event.type === EventType.TOOL_PREPARED) {
        evidence.prepared = event;
      } else if (event.type === EventType.TOOL_ATTEMPT_STARTED) {
        evidence.started = event;
      } else {
        evidence.completed = event;
      }
      attempts.set(event.attempt_id, evidence);
    }

    const decisions = new Map<string, ToolRecoveryDecision>();
    for (const toolCallId of callOrder) {
      const attempts = byCall.get(toolCallId);
      if (attempts === undefined) {
        continue;
      }
      const allAttempts = [...attempts.values()];
      const latest = allAttempts.at(-1);
      if (latest === undefined) {
        continue;
      }
      const identity = latest.completed ?? latest.started ?? latest.prepared;
      if (identity === undefined) {
        continue;
      }
      const attemptsObserved = allAttempts.length;

      if (latest.completed !== undefined) {
        const completed = latest.completed;
        if (completed.status === 'unknown') {
          const retry = canRetryUnknownAttempt(latest, attemptsObserved, this.maxAttempts);
          decisions.set(toolCallId, {
            tool_call_id: toolCallId,
            thread_id: identity.thread_id,
            attempt_id: identity.attempt_id,
            disposition: retry ? 'retry' : 'reconciliation_required',
            automatic_retry_allowed: retry,
            completion_unknown: true,
            attempts_observed: attemptsObserved,
            reason: retry
              ? 'The interrupted attempt was a retry-safe read and remains within the host retry budget.'
              : 'Completion is ambiguous and cannot be retried without reconciliation.',
          });
          continue;
        }
        if (completed.started_at === null && completed.failure_class === 'transport_before_dispatch') {
          decisions.set(toolCallId, {
            tool_call_id: toolCallId,
            thread_id: identity.thread_id,
            attempt_id: identity.attempt_id,
            disposition: 'not_dispatched',
            automatic_retry_allowed: false,
            completion_unknown: false,
            attempts_observed: attemptsObserved,
            reason: 'The attempt failed before provider dispatch.',
          });
          continue;
        }
        decisions.set(toolCallId, {
          tool_call_id: toolCallId,
          thread_id: identity.thread_id,
          attempt_id: identity.attempt_id,
          disposition: 'terminal',
          automatic_retry_allowed: false,
          completion_unknown: false,
          attempts_observed: attemptsObserved,
          reason: 'A durable terminal outcome exists; the original call must not be replayed.',
        });
        continue;
      }

      if (latest.started !== undefined) {
        const retry = canRetryUnknownAttempt(latest, attemptsObserved, this.maxAttempts);
        decisions.set(toolCallId, {
          tool_call_id: toolCallId,
          thread_id: identity.thread_id,
          attempt_id: identity.attempt_id,
          disposition: retry ? 'retry' : 'reconciliation_required',
          automatic_retry_allowed: retry,
          completion_unknown: true,
          attempts_observed: attemptsObserved,
          reason: retry
            ? 'Dispatch began for a retry-safe read but no durable completion exists.'
            : 'Dispatch began without a durable completion; reconcile before any new write.',
        });
        continue;
      }

      if (latest.prepared !== undefined) {
        decisions.set(toolCallId, {
          tool_call_id: toolCallId,
          thread_id: identity.thread_id,
          attempt_id: identity.attempt_id,
          disposition: 'not_dispatched',
          automatic_retry_allowed: false,
          completion_unknown: false,
          attempts_observed: attemptsObserved,
          reason: 'Preparation was durable but dispatch never began.',
        });
        continue;
      }

      decisions.set(toolCallId, {
        tool_call_id: toolCallId,
        thread_id: identity.thread_id,
        attempt_id: identity.attempt_id,
        disposition: 'manual_review',
        automatic_retry_allowed: false,
        completion_unknown: true,
        attempts_observed: attemptsObserved,
        reason: 'Lifecycle evidence is incomplete or inconsistent; fail closed.',
      });
    }

    return decisions;
  }
}
