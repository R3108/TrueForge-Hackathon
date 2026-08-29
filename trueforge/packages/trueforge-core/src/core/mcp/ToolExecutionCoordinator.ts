import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  EventType,
  newEventId,
  type ApprovalBinding,
  type ApprovalDecision,
  type ToolAttemptCompletedEvent,
  type ToolAttemptStartedEvent,
  type ToolExecutionFailureClass,
  type ToolExecutionLifecycleEvent,
  type ToolExecutionStatus,
  type ToolInvocationIdentity,
  type ToolPreparedEvent,
} from '../events/schema';
import { decodeArguments, fingerprintArguments } from './canonicalArguments';
import {
  DEFAULT_VERIFICATION_COORDINATOR,
  VerificationCoordinator,
  type EvidenceRecord,
  type EvidenceSourceIdentity,
} from './evidence';
import {
  isApprovalRequiredResponse,
  isAuthRequired,
  isCallToolResponseResult,
  isClientSideToolRequiredResponse,
  toolResultResponse,
  type CallToolResponse,
  type IToolSet,
  type ToolApprovalTargetIdentity,
} from './IMCPServer';
import { MAX_VALIDATION_VIOLATIONS, validateAgainstInputSchema } from './inputSchemaValidator';
import { ProgressAndRecoveryController } from './ProgressAndRecoveryController';
import { ToolCapabilityRegistry, type ToolCapability, type ToolConcurrency } from './ToolCapabilityRegistry';

export interface ToolInvocationKey {
  session_id: string | null;
  turn_id: string | null;
  thread_id: string;
  model_message_id: string | null;
  stable_tool_set_id: string;
  tool_name: string;
  tool_call_id: string;
  root_tool_call_id: string;
  parent_tool_call_id: string | null;
}

export type ToolExecutionEventRecorder = (event: ToolExecutionLifecycleEvent) => Promise<void>;

export interface ToolExecutionTurnScope {
  session_id: string;
  turn_id: string;
  event_recorder: ToolExecutionEventRecorder;
}

export interface ToolExecutionContext {
  session_id: string | null;
  turn_id: string | null;
  thread_id: string;
  model_message_id: string | null;
  root_tool_call_id: string | null;
  parent_tool_call_id: string | null;
  signal: AbortSignal | undefined;
  event_recorder: ToolExecutionEventRecorder | undefined;
}

export interface ToolExecutionInvocation {
  tool_call_id: string;
  tool_set: IToolSet | undefined;
  tool_name: string;
  arguments: unknown;
  approval_decision: ApprovalDecision | undefined;
  /**
   * Durable canonical approval identity carried from the pending call. Threaded to the coordinator so
   * it can be re-validated against live tool-set identity and current policy. Absent for calls that
   * never required approval and for legacy persisted decisions.
   */
  approval_binding?: ApprovalBinding | undefined;
  /**
   * Originating model.message id for the assistant call. Required to recompute the expected binding at
   * execution time. Null/undefined only for legacy contexts that predate the policy snapshot.
   */
  model_message_id?: string | null | undefined;
}

interface PreparedToolInvocationBase {
  index: number;
  invocation_key: ToolInvocationKey;
  attempt_id: string;
  capability: ToolCapability;
  argument_fingerprint: string;
  event_recorder: ToolExecutionEventRecorder | undefined;
}

export interface ReadyToolInvocation extends PreparedToolInvocationBase {
  kind: 'ready';
  tool_set: IToolSet;
  request: CallToolRequest['params'];
  approval_decision: ApprovalDecision | undefined;
  approval_binding: ApprovalBinding | undefined;
  model_message_id: string | null;
  decoded_arguments: Record<string, unknown>;
}

export interface TerminalToolInvocation extends PreparedToolInvocationBase {
  kind: 'terminal';
  response: CallToolResponse;
  failure_class: ToolExecutionFailureClass;
}

export type PreparedToolInvocation = ReadyToolInvocation | TerminalToolInvocation;

export interface PreparedBatch {
  invocations: readonly PreparedToolInvocation[];
}

export interface ToolExecutionOutcome {
  invocation_key: ToolInvocationKey;
  attempt_id: string;
  status: ToolExecutionStatus;
  failure_class: ToolExecutionFailureClass | null;
  started_at: string | null;
  completed_at: string;
  response: CallToolResponse;
  failure: boolean;
  error: Error | null;
  argument_fingerprint: string;
  capability: ToolCapability;
  /**
   * Bounded typed execution evidence verified from canonical structured output against the
   * host-declared {@link ToolCapability.output_schema}. Empty for every outcome that produced no
   * verifiable evidence: required actions, errors, cancellations, unknown/terminal invocations,
   * schema-less outcomes, and prose-only "successes".
   */
  evidence: readonly EvidenceRecord[];
}

export interface ReconciliationOutcome {
  status: ToolExecutionStatus;
  retry_allowed: boolean;
  reason: string;
}

function isRequiredActionResponse(response: CallToolResponse): boolean {
  return isAuthRequired(response) || isApprovalRequiredResponse(response) || isClientSideToolRequiredResponse(response);
}

/**
 * Extract the canonical MCP `structuredContent` from a resolved tool result, or `undefined` when the
 * response is not a resolved result or carries no structured content. This is the *only* channel the
 * verifier reads: prose `content` text is never surfaced here, so it can never become evidence.
 */
function structuredContentOf(response: CallToolResponse): unknown {
  if (!isCallToolResponseResult(response)) {
    return undefined;
  }
  return response.result.structuredContent;
}

function errorResponse(input: {
  code: string;
  message: string;
  completionUnknown: boolean;
  details?: Record<string, unknown> | undefined;
}): CallToolResponse {
  return toolResultResponse({
    text: JSON.stringify({
      error: input.code,
      message: input.message,
      completion_unknown: input.completionUnknown,
      retryable: false,
      ...(input.details ?? {}),
    }),
    isError: true,
  });
}

function invocationKey(input: {
  context: ToolExecutionContext;
  stableToolSetId: string;
  toolName: string;
  toolCallId: string;
}): ToolInvocationKey {
  const rootToolCallId = input.context.root_tool_call_id ?? input.toolCallId;
  return {
    session_id: input.context.session_id,
    turn_id: input.context.turn_id,
    thread_id: input.context.thread_id,
    model_message_id: input.context.model_message_id,
    stable_tool_set_id: input.stableToolSetId,
    tool_name: input.toolName,
    tool_call_id: input.toolCallId,
    root_tool_call_id: rootToolCallId,
    parent_tool_call_id: input.context.parent_tool_call_id,
  };
}

function durableIdentity(key: ToolInvocationKey): ToolInvocationIdentity {
  if (key.session_id === null || key.turn_id === null) {
    throw new Error('Durable tool execution events require non-null session and turn identity.');
  }
  return {
    session_id: key.session_id,
    turn_id: key.turn_id,
    thread_id: key.thread_id,
    model_message_id: key.model_message_id,
    stable_tool_set_id: key.stable_tool_set_id,
    tool_name: key.tool_name,
    tool_call_id: key.tool_call_id,
    root_tool_call_id: key.root_tool_call_id,
    parent_tool_call_id: key.parent_tool_call_id,
  };
}

function capabilitySnapshot(capability: ToolCapability): ToolPreparedEvent['capability'] {
  return {
    side_effect_class: capability.side_effect_class,
    retry_capability: capability.retry_capability,
    concurrency: capability.concurrency,
    timeout_ms: capability.timeout_ms,
    result_size_class: capability.result_size_class,
  };
}

async function recordPrepared(prepared: PreparedToolInvocation): Promise<void> {
  if (prepared.event_recorder === undefined) {
    return;
  }
  const event: ToolPreparedEvent = {
    ...durableIdentity(prepared.invocation_key),
    type: EventType.TOOL_PREPARED,
    id: newEventId(),
    created_at: new Date().toISOString(),
    attempt_id: prepared.attempt_id,
    argument_fingerprint: prepared.argument_fingerprint,
    capability: capabilitySnapshot(prepared.capability),
    disposition: prepared.kind === 'ready' ? 'ready' : 'terminal',
    failure_class: prepared.kind === 'terminal' ? prepared.failure_class : null,
  };
  await prepared.event_recorder(event);
}

async function recordStarted(prepared: ReadyToolInvocation, startedAt: string): Promise<void> {
  if (prepared.event_recorder === undefined) {
    return;
  }
  const event: ToolAttemptStartedEvent = {
    ...durableIdentity(prepared.invocation_key),
    type: EventType.TOOL_ATTEMPT_STARTED,
    id: newEventId(),
    created_at: startedAt,
    attempt_id: prepared.attempt_id,
    started_at: startedAt,
  };
  await prepared.event_recorder(event);
}

async function recordCompleted(
  prepared: PreparedToolInvocation,
  outcome: ToolExecutionOutcome,
): Promise<ToolExecutionOutcome> {
  if (prepared.event_recorder !== undefined) {
    const event: ToolAttemptCompletedEvent = {
      ...durableIdentity(outcome.invocation_key),
      type: EventType.TOOL_ATTEMPT_COMPLETED,
      id: newEventId(),
      created_at: outcome.completed_at,
      attempt_id: outcome.attempt_id,
      status: outcome.status,
      failure_class: outcome.failure_class,
      started_at: outcome.started_at,
      completed_at: outcome.completed_at,
      argument_fingerprint: outcome.argument_fingerprint,
      evidence: [...outcome.evidence],
    };
    await prepared.event_recorder(event);
  }
  return outcome;
}

interface ActiveToolExecution {
  invocation_key: ToolInvocationKey;
  signal: AbortSignal | undefined;
  event_recorder: ToolExecutionEventRecorder | undefined;
}

const activeToolExecution = new AsyncLocalStorage<ActiveToolExecution>();

export function inheritedToolExecutionContext(options: { fallbackThreadId: string }): ToolExecutionContext {
  const active = activeToolExecution.getStore();
  if (active === undefined) {
    return {
      session_id: null,
      turn_id: null,
      thread_id: options.fallbackThreadId,
      model_message_id: null,
      root_tool_call_id: null,
      parent_tool_call_id: null,
      signal: undefined,
      event_recorder: undefined,
    };
  }
  return {
    session_id: active.invocation_key.session_id,
    turn_id: active.invocation_key.turn_id,
    thread_id: active.invocation_key.thread_id,
    model_message_id: active.invocation_key.model_message_id,
    root_tool_call_id: active.invocation_key.root_tool_call_id,
    parent_tool_call_id: active.invocation_key.tool_call_id,
    signal: active.signal,
    event_recorder: active.event_recorder,
  };
}

function awaitDispatch<T>(options: {
  dispatch: Promise<T>;
  signal: AbortSignal | undefined;
}): Promise<{ kind: 'completed'; value: T } | { kind: 'cancelled' }> {
  if (options.signal === undefined) {
    return options.dispatch.then(value => ({ kind: 'completed', value }));
  }
  const signal = options.signal;
  if (signal.aborted) {
    void options.dispatch.catch(() => undefined);
    return Promise.resolve({ kind: 'cancelled' });
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      resolve({ kind: 'cancelled' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    options.dispatch.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'completed', value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Tool dispatch rejected', { cause: error }));
      },
    );
  });
}

function cancelledBeforeDispatchOutcome(prepared: ReadyToolInvocation): ToolExecutionOutcome {
  return {
    invocation_key: prepared.invocation_key,
    attempt_id: prepared.attempt_id,
    status: 'failed',
    failure_class: 'cancelled',
    started_at: null,
    completed_at: new Date().toISOString(),
    response: errorResponse({
      code: 'cancelled_before_dispatch',
      message: 'Tool call was cancelled before dispatch.',
      completionUnknown: false,
    }),
    failure: true,
    error: null,
    argument_fingerprint: prepared.argument_fingerprint,
    capability: prepared.capability,
    evidence: [],
  };
}

function terminalOutcome(prepared: TerminalToolInvocation): ToolExecutionOutcome {
  return {
    invocation_key: prepared.invocation_key,
    attempt_id: prepared.attempt_id,
    status: 'failed',
    failure_class: prepared.failure_class,
    started_at: null,
    completed_at: new Date().toISOString(),
    response: prepared.response,
    failure: true,
    error: null,
    argument_fingerprint: prepared.argument_fingerprint,
    capability: prepared.capability,
    evidence: [],
  };
}

/**
 * Recompute the expected durable approval binding from the request-aware live approval target
 * identity, current policy, and the freshly decoded arguments. This never trusts the supplied binding
 * for any field — it is the ground truth the supplied binding must match.
 *
 * The target identity follows wrapper delegation: for a direct tool set it is the tool set's own
 * identity plus the requested tool name; for DeferredTool's `call_tool` it is the *underlying*
 * server/tool/policy the wrapper resolves to. This is what lets an approved deferred `call_tool`
 * whose binding was minted against the underlying server/tool/policy recompute and match, instead of
 * failing closed on the wrapper's missing policy. The canonical full root model-argument fingerprint
 * and the wrapper lifecycle identity (thread/tool-call/model-message) are retained from the prepared
 * invocation. A tool set that only exposes {@link IToolSet.policyIdentity} falls back to that plus the
 * requested tool name for compatibility.
 */
function expectedApprovalBinding(prepared: ReadyToolInvocation): ApprovalBinding | undefined {
  const target = resolveApprovalTargetIdentity(prepared.tool_set, prepared.request);
  if (target === undefined) {
    return undefined;
  }
  if (prepared.model_message_id === null) {
    return undefined;
  }
  return {
    version: 1,
    thread_id: prepared.invocation_key.thread_id,
    model_message_id: prepared.model_message_id,
    tool_call_id: prepared.invocation_key.tool_call_id,
    stable_tool_set_id: target.stable_tool_set_id,
    original_tool_name: target.original_tool_name,
    argument_fingerprint: fingerprintArguments(prepared.decoded_arguments),
    policy: { policy_id: target.policy_id, policy_version: target.policy_version },
  };
}

/**
 * Resolve the request-aware approval target identity for a call. Prefers the request-aware
 * {@link IToolSet.approvalTargetIdentity}; falls back to the request-independent
 * {@link IToolSet.policyIdentity} (paired with the requested tool name) for tool sets that predate the
 * request-aware accessor. Absence in both means the call exposes no bindable target.
 */
function resolveApprovalTargetIdentity(
  toolSet: IToolSet,
  request: CallToolRequest['params'],
): ToolApprovalTargetIdentity | undefined {
  const target = toolSet.approvalTargetIdentity?.(request);
  if (target !== undefined) {
    return target;
  }
  const identity = toolSet.policyIdentity?.();
  if (identity === undefined) {
    return undefined;
  }
  return {
    stable_tool_set_id: identity.stable_tool_set_id,
    original_tool_name: request.name,
    policy_id: identity.policy_id,
    policy_version: identity.policy_version,
  };
}

function bindingsEqual(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return (
    left.thread_id === right.thread_id &&
    left.model_message_id === right.model_message_id &&
    left.tool_call_id === right.tool_call_id &&
    left.stable_tool_set_id === right.stable_tool_set_id &&
    left.original_tool_name === right.original_tool_name &&
    left.argument_fingerprint === right.argument_fingerprint &&
    left.policy.policy_id === right.policy.policy_id &&
    left.policy.policy_version === right.policy.policy_version
  );
}

function policyFailureOutcome(
  prepared: ReadyToolInvocation,
  input: { code: string; message: string },
): ToolExecutionOutcome {
  return {
    invocation_key: prepared.invocation_key,
    attempt_id: prepared.attempt_id,
    status: 'failed',
    failure_class: 'policy',
    started_at: null,
    completed_at: new Date().toISOString(),
    response: errorResponse({ code: input.code, message: input.message, completionUnknown: false }),
    failure: true,
    error: null,
    argument_fingerprint: prepared.argument_fingerprint,
    capability: prepared.capability,
    evidence: [],
  };
}

function resourcesConflict(left: ToolConcurrency, right: ToolConcurrency): boolean {
  if (left.kind !== 'resource_scoped' || right.kind !== 'resource_scoped') {
    return false;
  }
  const leftResources = new Set(left.resources);
  return right.resources.some(resource => leftResources.has(resource));
}

/** Canonical host execution boundary. Provider-specific callTool methods remain internal dispatch leaves. */
export class ToolExecutionCoordinator {
  private readonly capabilities: ToolCapabilityRegistry;
  private readonly recovery: ProgressAndRecoveryController;
  private readonly verification: VerificationCoordinator;

  constructor(
    options: {
      capabilities?: ToolCapabilityRegistry | undefined;
      recovery?: ProgressAndRecoveryController | undefined;
      verification?: VerificationCoordinator | undefined;
    } = {},
  ) {
    this.capabilities = options.capabilities ?? new ToolCapabilityRegistry();
    this.recovery = options.recovery ?? new ProgressAndRecoveryController();
    this.verification = options.verification ?? DEFAULT_VERIFICATION_COORDINATOR;
  }

  async prepareBatch(options: {
    invocations: readonly ToolExecutionInvocation[];
    context: ToolExecutionContext;
  }): Promise<PreparedBatch> {
    const invocations = options.invocations.map((invocation, index): PreparedToolInvocation => {
      const stableToolSetId = invocation.tool_set?.id ?? 'unknown';
      const key = invocationKey({
        context: options.context,
        stableToolSetId,
        toolName: invocation.tool_name,
        toolCallId: invocation.tool_call_id,
      });
      const capability = this.capabilities.resolve({
        stableToolSetId,
        toolName: invocation.tool_name,
        hostCapability: invocation.tool_set?.getToolCapability?.(invocation.tool_name),
      });
      const decoded = decodeArguments(invocation.arguments);
      const argumentFingerprint = fingerprintArguments(decoded.ok ? decoded.value : invocation.arguments);
      const base: PreparedToolInvocationBase = {
        index,
        invocation_key: key,
        attempt_id: randomUUID(),
        capability,
        argument_fingerprint: argumentFingerprint,
        event_recorder: options.context.event_recorder,
      };

      if (!invocation.tool_set) {
        return {
          ...base,
          kind: 'terminal',
          response: errorResponse({
            code: 'unknown_tool',
            message: `Tool ${invocation.tool_name} was not found in the tool mapping.`,
            completionUnknown: false,
          }),
          failure_class: 'validation',
        };
      }
      if (!decoded.ok) {
        return {
          ...base,
          kind: 'terminal',
          response: errorResponse({
            code: 'invalid_arguments',
            message: decoded.reason,
            completionUnknown: false,
          }),
          failure_class: 'validation',
        };
      }
      // Live input-schema validation. Runs after strict decode and the known-tool check, and before
      // approval, preflight, and dispatch. The tool set owns the discovered schema; an absent schema
      // (unknown/undiscovered/unavailable) or a malformed schema skips safely. A known violation of the
      // tool's own advertised contract fails closed here so it never reaches policy or the dispatch leaf.
      const inputSchema = invocation.tool_set.getToolInputSchema?.(invocation.tool_name);
      if (inputSchema !== undefined) {
        const validation = validateAgainstInputSchema(decoded.value, inputSchema);
        if (!validation.ok) {
          const violations = validation.violations.slice(0, MAX_VALIDATION_VIOLATIONS);
          return {
            ...base,
            kind: 'terminal',
            response: errorResponse({
              code: 'input_schema_validation_failed',
              message: 'Tool arguments do not satisfy the tool input schema.',
              completionUnknown: false,
              details: { violations, truncated: validation.truncated },
            }),
            failure_class: 'validation',
          };
        }
      }
      return {
        ...base,
        kind: 'ready',
        tool_set: invocation.tool_set,
        request: { name: invocation.tool_name, arguments: decoded.value },
        approval_decision: invocation.approval_decision,
        approval_binding: invocation.approval_binding,
        model_message_id: invocation.model_message_id ?? key.model_message_id,
        decoded_arguments: decoded.value,
      };
    });
    for (const prepared of invocations) {
      await recordPrepared(prepared);
    }
    return { invocations };
  }

  /**
   * Generic output verification applied at finalization to a nominally *succeeded* outcome. Driven by
   * the host-owned {@link ToolCapability.output_schema} / {@link ToolCapability.evidence_capabilities}.
   *
   * - A null output schema (or any non-`succeeded` outcome) is left untouched and carries no evidence.
   * - A declared output schema with valid canonical `structuredContent` attaches bounded typed
   *   evidence to the outcome (never the raw output) when a durable source identity is present, or
   *   remains verified-but-evidence-free when the call has no durable session/turn (identity-less
   *   local/nested/Code-Mode dispatch). Identity is never fabricated.
   * - A declared output schema with missing structured content or a schema mismatch rewrites the
   *   outcome into a `validation` failure with a bounded structured error, zero evidence, and no
   *   retry — prose is never treated as execution evidence. This holds **regardless of source
   *   identity**: the schema/structured gate is a property of the result, so an identity-less call
   *   cannot bypass it.
   *
   * Every other outcome (required action, error, cancellation, unknown, terminal) passes through
   * unchanged with empty evidence.
   */
  private finalizeVerification(prepared: ReadyToolInvocation, outcome: ToolExecutionOutcome): ToolExecutionOutcome {
    if (outcome.status !== 'succeeded') {
      return outcome;
    }
    const outputSchema = prepared.capability.output_schema;
    if (outputSchema === null || outputSchema === undefined) {
      return outcome;
    }
    // Durable source identity is required to mint an EvidenceRecord, but its absence must NOT bypass
    // schema/structured verification. Compute the source only when session/turn are present; when they
    // are null the verifier still validates the result and returns verified-but-evidence-free.
    const source: EvidenceSourceIdentity | null =
      prepared.invocation_key.session_id !== null && prepared.invocation_key.turn_id !== null
        ? {
            session_id: prepared.invocation_key.session_id,
            turn_id: prepared.invocation_key.turn_id,
            thread_id: prepared.invocation_key.thread_id,
            stable_tool_set_id: prepared.invocation_key.stable_tool_set_id,
            tool_name: prepared.invocation_key.tool_name,
            tool_call_id: prepared.invocation_key.tool_call_id,
            root_tool_call_id: prepared.invocation_key.root_tool_call_id,
            attempt_id: outcome.attempt_id,
          }
        : null;
    const result = this.verification.verify({
      output_schema: outputSchema,
      evidence_capabilities: prepared.capability.evidence_capabilities,
      structured_content: structuredContentOf(outcome.response),
      source,
    });
    if (result.kind === 'skipped') {
      return outcome;
    }
    if (result.kind === 'verified') {
      return { ...outcome, evidence: result.evidence };
    }
    return {
      ...outcome,
      status: 'failed',
      failure_class: 'validation',
      response: errorResponse({
        code: result.error.code,
        message: result.error.message,
        completionUnknown: false,
        details: { violations: result.error.violations, truncated: result.error.truncated },
      }),
      failure: true,
      error: null,
      evidence: [],
    };
  }

  private async executeAttempt(options: {
    prepared: PreparedToolInvocation;
    signal: AbortSignal | undefined;
  }): Promise<ToolExecutionOutcome> {
    if (options.prepared.kind === 'terminal') {
      return recordCompleted(options.prepared, terminalOutcome(options.prepared));
    }

    const prepared = options.prepared;
    if (options.signal?.aborted) {
      return recordCompleted(prepared, cancelledBeforeDispatchOutcome(prepared));
    }

    // Fail closed on an allow decision whose durable binding is missing or does not match the binding
    // recomputed from live tool-set identity, current policy, and the freshly decoded arguments. This
    // runs after strict decode and before any preflight/dispatch. A deny decision is intentionally not
    // gated here: it remains terminal in preflight even without a binding. Only root model tool calls
    // are gated — nested/Code Mode dispatch inherits the approved parent's trust and carries no binding.
    if (prepared.approval_decision?.status === 'allow' && prepared.invocation_key.parent_tool_call_id === null) {
      const expected = expectedApprovalBinding(prepared);
      if (expected === undefined) {
        return recordCompleted(
          prepared,
          policyFailureOutcome(prepared, {
            code: 'approval_binding_unavailable',
            message:
              'Approved tool call cannot be bound to a policy identity; the tool set exposes no policy or the ' +
              'originating model message is unknown. Failing closed and requiring a fresh approval.',
          }),
        );
      }
      if (prepared.approval_binding === undefined) {
        return recordCompleted(
          prepared,
          policyFailureOutcome(prepared, {
            code: 'approval_binding_missing',
            message:
              'Approved tool call is missing its durable approval binding. A persisted allow decision without a ' +
              'binding fails closed and requires a fresh human approval.',
          }),
        );
      }
      if (!bindingsEqual(prepared.approval_binding, expected)) {
        return recordCompleted(
          prepared,
          policyFailureOutcome(prepared, {
            code: 'approval_binding_mismatch',
            message:
              'Approved tool call binding does not match the call as it exists now (arguments, tool set, or policy ' +
              'changed since approval). Failing closed and requiring a fresh human approval.',
          }),
        );
      }
    }

    let dispatchTool = (): Promise<CallToolResponse> =>
      prepared.approval_decision === undefined
        ? prepared.tool_set.callTool(prepared.request)
        : prepared.tool_set.callTool(prepared.request, prepared.approval_decision);

    if (prepared.tool_set.prepareToolCall !== undefined) {
      let preflight: Awaited<ReturnType<NonNullable<IToolSet['prepareToolCall']>>>;
      try {
        preflight = await prepared.tool_set.prepareToolCall(prepared.request, prepared.approval_decision);
      } catch (error) {
        const preflightError = error instanceof Error ? error : new Error('Tool preflight failed', { cause: error });
        const outcome: ToolExecutionOutcome = {
          invocation_key: prepared.invocation_key,
          attempt_id: prepared.attempt_id,
          status: 'failed',
          failure_class: 'transport_before_dispatch',
          started_at: null,
          completed_at: new Date().toISOString(),
          response: errorResponse({
            code: 'tool_preflight_failed',
            message: preflightError.message,
            completionUnknown: false,
          }),
          failure: true,
          error: preflightError,
          argument_fingerprint: prepared.argument_fingerprint,
          capability: prepared.capability,
          evidence: [],
        };
        return recordCompleted(prepared, outcome);
      }

      if (options.signal?.aborted) {
        return recordCompleted(prepared, cancelledBeforeDispatchOutcome(prepared));
      }

      if (preflight.kind !== 'dispatch') {
        const resultFailed = isCallToolResponseResult(preflight.response) && preflight.response.result.isError === true;
        const outcome: ToolExecutionOutcome = {
          invocation_key: prepared.invocation_key,
          attempt_id: prepared.attempt_id,
          status: preflight.kind === 'required_action' ? 'required_action' : resultFailed ? 'failed' : 'succeeded',
          failure_class: resultFailed ? 'domain' : null,
          started_at: null,
          completed_at: new Date().toISOString(),
          response: preflight.response,
          failure: resultFailed,
          error: null,
          argument_fingerprint: prepared.argument_fingerprint,
          capability: prepared.capability,
          evidence: [],
        };
        return recordCompleted(prepared, this.finalizeVerification(prepared, outcome));
      }

      dispatchTool = preflight.dispatch;
    }

    const startedAt = new Date().toISOString();
    await recordStarted(prepared, startedAt);

    let outcome: ToolExecutionOutcome;
    try {
      const dispatch = activeToolExecution.run(
        {
          invocation_key: prepared.invocation_key,
          signal: options.signal,
          event_recorder: prepared.event_recorder,
        },
        dispatchTool,
      );
      const dispatchResult = await awaitDispatch({ dispatch, signal: options.signal });
      if (dispatchResult.kind === 'cancelled') {
        const completionUnknown = prepared.capability.side_effect_class !== 'read_only';
        outcome = {
          invocation_key: prepared.invocation_key,
          attempt_id: prepared.attempt_id,
          status: completionUnknown ? 'unknown' : 'failed',
          failure_class: 'cancelled_after_dispatch',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          response: errorResponse({
            code: 'cancelled_after_dispatch',
            message: 'Tool call was cancelled after dispatch began.',
            completionUnknown,
          }),
          failure: true,
          error: null,
          argument_fingerprint: prepared.argument_fingerprint,
          capability: prepared.capability,
          evidence: [],
        };
      } else {
        const response = dispatchResult.value;
        const requiredAction = isRequiredActionResponse(response);
        const resultFailed = isCallToolResponseResult(response) && response.result.isError === true;
        outcome = {
          invocation_key: prepared.invocation_key,
          attempt_id: prepared.attempt_id,
          status: requiredAction ? 'required_action' : resultFailed ? 'failed' : 'succeeded',
          failure_class: resultFailed ? 'domain' : null,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          response,
          failure: resultFailed,
          error: null,
          argument_fingerprint: prepared.argument_fingerprint,
          capability: prepared.capability,
          evidence: [],
        };
        outcome = this.finalizeVerification(prepared, outcome);
      }
    } catch (error) {
      const completionUnknown = prepared.capability.side_effect_class !== 'read_only';
      const dispatchError = error instanceof Error ? error : new Error('Tool execution failed', { cause: error });
      outcome = {
        invocation_key: prepared.invocation_key,
        attempt_id: prepared.attempt_id,
        status: completionUnknown ? 'unknown' : 'failed',
        failure_class: 'transport_after_dispatch',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        response: errorResponse({
          code: completionUnknown ? 'tool_completion_unknown' : 'tool_execution_failed',
          message: dispatchError.message,
          completionUnknown,
        }),
        failure: true,
        error: dispatchError,
        argument_fingerprint: prepared.argument_fingerprint,
        capability: prepared.capability,
        evidence: [],
      };
    }
    return recordCompleted(prepared, outcome);
  }

  async execute(options: {
    prepared: PreparedToolInvocation;
    signal: AbortSignal | undefined;
  }): Promise<ToolExecutionOutcome> {
    if (options.prepared.kind === 'terminal') {
      return this.executeAttempt(options);
    }

    let prepared = options.prepared;
    let attemptsStarted = 0;

    for (;;) {
      attemptsStarted++;
      const outcome = await this.executeAttempt({ prepared, signal: options.signal });
      if (!this.recovery.shouldRetry({ outcome, attempts_started: attemptsStarted })) {
        return outcome;
      }

      prepared = {
        ...prepared,
        attempt_id: randomUUID(),
      };
      await recordPrepared(prepared);
    }
  }

  async executeBatch(options: {
    batch: PreparedBatch;
    signal: AbortSignal | undefined;
  }): Promise<readonly ToolExecutionOutcome[]> {
    const outcomes = new Map<number, ToolExecutionOutcome>();
    let wave: ReadyToolInvocation[] = [];

    const flush = async (): Promise<void> => {
      const pending = wave;
      wave = [];
      const completed = await Promise.all(pending.map(prepared => this.execute({ prepared, signal: options.signal })));
      for (let index = 0; index < pending.length; index++) {
        const prepared = pending[index];
        const outcome = completed[index];
        if (!prepared || !outcome) {
          throw new Error('Tool execution wave lost result ordering.');
        }
        outcomes.set(prepared.index, outcome);
      }
    };

    for (const prepared of options.batch.invocations) {
      if (prepared.kind === 'terminal') {
        outcomes.set(prepared.index, await this.execute({ prepared, signal: options.signal }));
        continue;
      }

      const concurrency = prepared.capability.concurrency;
      if (concurrency.kind === 'exclusive') {
        await flush();
        outcomes.set(prepared.index, await this.execute({ prepared, signal: options.signal }));
        continue;
      }

      const conflicts = wave.some(candidate => resourcesConflict(candidate.capability.concurrency, concurrency));
      if (conflicts) {
        await flush();
      }
      wave.push(prepared);
    }
    await flush();

    return options.batch.invocations.map(prepared => {
      const outcome = outcomes.get(prepared.index);
      if (!outcome) {
        throw new Error(`Tool execution produced no outcome for index ${String(prepared.index)}.`);
      }
      return outcome;
    });
  }

  executeInvocation(options: {
    invocation: ToolExecutionInvocation;
    context: ToolExecutionContext;
  }): Promise<ToolExecutionOutcome> {
    return this.prepareBatch({ invocations: [options.invocation], context: options.context }).then(batch => {
      const prepared = batch.invocations[0];
      if (!prepared) {
        throw new Error('Tool preparation produced no invocation.');
      }
      return this.execute({ prepared, signal: options.context.signal });
    });
  }

  reconcile(options: { outcome: ToolExecutionOutcome }): Promise<ReconciliationOutcome> {
    if (options.outcome.status !== 'unknown') {
      return Promise.resolve({
        status: options.outcome.status,
        retry_allowed: false,
        reason: 'Only unknown outcomes require reconciliation.',
      });
    }
    return Promise.resolve({
      status: 'unknown',
      retry_allowed: false,
      reason: 'No host reconciliation adapter is registered; fail closed and require human review.',
    });
  }
}

export const DEFAULT_TOOL_EXECUTION_COORDINATOR = new ToolExecutionCoordinator();
