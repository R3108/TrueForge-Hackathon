import {
  EventType,
  ToolExecutionLifecycleEventSchema,
  type ToolExecutionLifecycleEvent,
} from '../../../src/core/events/schema';
import { ProgressAndRecoveryController } from '../../../src/core/mcp/ProgressAndRecoveryController';

const ATTEMPT_ONE = '00000000-0000-4000-8000-000000000001';
const ATTEMPT_TWO = '00000000-0000-4000-8000-000000000002';

function lifecycleEvent(input: {
  type: ToolExecutionLifecycleEvent['type'];
  attemptId?: string;
  sideEffectClass?: 'read_only' | 'remote_write';
  retryCapability?: 'safe' | 'never';
  status?: 'succeeded' | 'failed' | 'unknown';
  startedAt?: string | null;
}): ToolExecutionLifecycleEvent {
  const attemptId = input.attemptId ?? ATTEMPT_ONE;
  const base = {
    id: `event-${input.type}-${attemptId}`,
    created_at: '2026-01-01T00:00:00.000Z',
    session_id: 'session-1',
    turn_id: 'turn-1',
    thread_id: 'main',
    model_message_id: 'message-1',
    stable_tool_set_id: 'tools',
    tool_name: 'operation',
    tool_call_id: 'call-1',
    root_tool_call_id: 'call-1',
    parent_tool_call_id: null,
    attempt_id: attemptId,
  };

  if (input.type === EventType.TOOL_PREPARED) {
    return ToolExecutionLifecycleEventSchema.parse({
      ...base,
      type: input.type,
      argument_fingerprint: 'a'.repeat(64),
      capability: {
        side_effect_class: input.sideEffectClass ?? 'remote_write',
        retry_capability: input.retryCapability ?? 'never',
        concurrency: { kind: 'exclusive' },
        timeout_ms: null,
        result_size_class: 'unknown',
      },
      disposition: 'ready',
      failure_class: null,
    });
  }
  if (input.type === EventType.TOOL_ATTEMPT_STARTED) {
    return ToolExecutionLifecycleEventSchema.parse({
      ...base,
      type: input.type,
      started_at: '2026-01-01T00:00:01.000Z',
    });
  }
  return ToolExecutionLifecycleEventSchema.parse({
    ...base,
    type: input.type,
    status: input.status ?? 'succeeded',
    failure_class: input.status === 'unknown' ? 'transport_after_dispatch' : null,
    started_at: input.startedAt ?? '2026-01-01T00:00:01.000Z',
    completed_at: '2026-01-01T00:00:02.000Z',
    argument_fingerprint: 'a'.repeat(64),
  });
}

function decision(events: ToolExecutionLifecycleEvent[]) {
  return new ProgressAndRecoveryController().classifyPersisted(events).get('call-1');
}

describe('ProgressAndRecoveryController', () => {
  it('classifies prepared-only writes as definitely not dispatched', () => {
    expect(decision([lifecycleEvent({ type: EventType.TOOL_PREPARED })])).toMatchObject({
      disposition: 'not_dispatched',
      automatic_retry_allowed: false,
      completion_unknown: false,
    });
  });

  it('allows one bounded retry for a started-without-completed safe read', () => {
    expect(
      decision([
        lifecycleEvent({
          type: EventType.TOOL_PREPARED,
          sideEffectClass: 'read_only',
          retryCapability: 'safe',
        }),
        lifecycleEvent({ type: EventType.TOOL_ATTEMPT_STARTED }),
      ]),
    ).toMatchObject({
      disposition: 'retry',
      automatic_retry_allowed: true,
      completion_unknown: true,
      attempts_observed: 1,
    });
  });

  it('requires reconciliation for a started write with no durable completion', () => {
    expect(
      decision([
        lifecycleEvent({ type: EventType.TOOL_PREPARED }),
        lifecycleEvent({ type: EventType.TOOL_ATTEMPT_STARTED }),
      ]),
    ).toMatchObject({
      disposition: 'reconciliation_required',
      automatic_retry_allowed: false,
      completion_unknown: true,
    });
  });

  it('never replays a durably completed attempt', () => {
    expect(
      decision([
        lifecycleEvent({ type: EventType.TOOL_PREPARED }),
        lifecycleEvent({ type: EventType.TOOL_ATTEMPT_STARTED }),
        lifecycleEvent({ type: EventType.TOOL_ATTEMPT_COMPLETED, status: 'succeeded' }),
      ]),
    ).toMatchObject({
      disposition: 'terminal',
      automatic_retry_allowed: false,
      completion_unknown: false,
    });
  });

  it('fails closed when a safe read has exhausted its attempt budget', () => {
    expect(
      decision([
        lifecycleEvent({
          type: EventType.TOOL_PREPARED,
          attemptId: ATTEMPT_ONE,
          sideEffectClass: 'read_only',
          retryCapability: 'safe',
        }),
        lifecycleEvent({ type: EventType.TOOL_ATTEMPT_STARTED, attemptId: ATTEMPT_ONE }),
        lifecycleEvent({
          type: EventType.TOOL_PREPARED,
          attemptId: ATTEMPT_TWO,
          sideEffectClass: 'read_only',
          retryCapability: 'safe',
        }),
        lifecycleEvent({ type: EventType.TOOL_ATTEMPT_STARTED, attemptId: ATTEMPT_TWO }),
      ]),
    ).toMatchObject({
      disposition: 'reconciliation_required',
      automatic_retry_allowed: false,
      attempts_observed: 2,
    });
  });
});
