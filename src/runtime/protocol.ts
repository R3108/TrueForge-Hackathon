import type {
  PendingAction,
  ToolInvocation,
  ValidationViolation,
} from './contracts.ts';

export interface StreamEvent {
  type: string;
  id?: string;
  turnId?: string;
  turn_id?: string;
  threadId?: string | null;
  thread_id?: string | null;
  content?: unknown;
  [key: string]: unknown;
}

export interface ResolvedToolCall {
  id: string;
  name: string;
  arguments: unknown;
  validationViolations: ValidationViolation[];
  toolSetId: string;
  toolSetName: string;
  toolType: 'mcp' | 'truefoundry-system' | 'unknown';
}

interface ToolCallReference {
  id: string;
  sourceEventId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function threadIdOf(event: StreamEvent): string {
  return text(event.threadId ?? event.thread_id) ?? 'main';
}

export function toolCallsOf(event: StreamEvent): ResolvedToolCall[] {
  const calls = event.toolCalls ?? event.tool_calls;
  if (!Array.isArray(calls)) return [];

  return calls.flatMap((value): ResolvedToolCall[] => {
    const call = record(value);
    if (!call) return [];
    const fn = record(call.function) ?? call;
    const id = text(call.id ?? call.toolCallId ?? call.tool_call_id);
    const name = text(fn.name);
    if (!id || !name) return [];

    const raw = fn.arguments ?? fn.args;
    let args = raw;
    const violations: ValidationViolation[] = [];
    if (typeof raw === 'string') {
      try {
        args = JSON.parse(raw) as unknown;
      } catch {
        violations.push({
          code: 'invalid_json',
          field: 'arguments',
          message: 'Tool arguments must be valid JSON.',
          repairable: true,
        });
      }
    }

    const toolInfo = record(call.toolInfo ?? call.tool_info);
    const toolTypeValue = text(toolInfo?.type);
    const toolType =
      toolTypeValue === 'mcp' || toolTypeValue === 'truefoundry-system'
        ? toolTypeValue
        : 'unknown';
    const toolSetId = text(toolInfo?.serverId ?? toolInfo?.server_id) ?? 'unknown';
    const toolSetName = text(toolInfo?.serverName ?? toolInfo?.server_name) ?? 'unknown';

    return [{
      id,
      name,
      arguments: args,
      validationViolations: violations,
      toolSetId,
      toolSetName,
      toolType,
    }];
  });
}

function referencesOf(event: StreamEvent): ToolCallReference[] {
  const refs = event.toolCalls ?? event.tool_calls;
  if (Array.isArray(refs)) {
    return refs.map((value, index): ToolCallReference => {
      const ref = record(value);
      if (!ref) {
        throw new Error(`Required action reference ${index} must be an object.`);
      }
      const id = text(ref.id ?? ref.toolCallId ?? ref.tool_call_id);
      const sourceEventId = text(ref.sourceEventId ?? ref.source_event_id);
      if (!id || !sourceEventId) {
        throw new Error(
          `Required action reference ${index} must include both call ID and source event ID.`,
        );
      }
      return { id, sourceEventId };
    });
  }

  // Compatibility with early stream fixtures that exposed one scalar reference.
  const rawId = event.toolCallId ?? event.tool_call_id;
  const rawSourceEventId = event.sourceEventId ?? event.source_event_id;
  const id = text(rawId);
  const sourceEventId = text(rawSourceEventId);
  if ((rawId !== undefined || rawSourceEventId !== undefined) && (!id || !sourceEventId)) {
    throw new Error('Required action must include both scalar call ID and source event ID.');
  }
  return id && sourceEventId ? [{ id, sourceEventId }] : [];
}

export function requiredActionIdentity(event: StreamEvent): string {
  const refs = referencesOf(event)
    .map((ref) => `${ref.sourceEventId}:${ref.id}`)
    .sort()
    .join(',');
  return `${event.type}:${threadIdOf(event)}:${refs}`;
}

/** Resolve every reference in a required action to the exact call ID it names. */
export function resolveRequiredAction(
  event: StreamEvent,
  eventIndex: ReadonlyMap<string, StreamEvent>,
  context: { sessionId: string; turnId: string; policyVersion: string },
): PendingAction[] {
  const kind =
    event.type === 'tool.approval_required'
      ? 'approval'
      : event.type === 'tool.response_required'
        ? 'response'
        : undefined;
  if (!kind) throw new Error(`Unsupported required action type: ${event.type}`);

  const refs = referencesOf(event);
  if (refs.length === 0) {
    throw new Error(`${event.type} did not contain any complete tool-call references.`);
  }

  const actionThreadId = threadIdOf(event);
  const seenReferences = new Set<string>();

  return refs.map((ref): PendingAction => {
    const referenceIdentity = `${ref.sourceEventId}\u0000${ref.id}`;
    if (seenReferences.has(referenceIdentity)) {
      throw new Error(`Required action contains duplicate reference ${ref.id}.`);
    }
    seenReferences.add(referenceIdentity);

    const source = eventIndex.get(ref.sourceEventId);
    if (!source || source.type !== 'model.message') {
      throw new Error(`Required action references missing model event ${ref.sourceEventId}.`);
    }
    if (threadIdOf(source) !== actionThreadId) {
      throw new Error(
        `Required action thread ${actionThreadId} does not match source thread ${threadIdOf(source)}.`,
      );
    }

    const matches = toolCallsOf(source).filter((call) => call.id === ref.id);
    const addressableMatches = [...eventIndex.values()].flatMap((candidate) =>
      candidate.type === 'model.message' && threadIdOf(candidate) === actionThreadId
        ? toolCallsOf(candidate).filter((call) => call.id === ref.id)
        : [],
    );
    if (matches.length !== 1 || addressableMatches.length !== 1) {
      throw new Error(
        `Required action could not resolve exactly one addressable call ${ref.id} in thread ${actionThreadId}.`,
      );
    }
    const call = matches[0];
    if (!call) throw new Error(`Tool call ${ref.id} unexpectedly disappeared.`);

    const invocation: ToolInvocation = {
      key: {
        sessionId: context.sessionId,
        turnId: context.turnId,
        threadId: actionThreadId,
        toolCallId: call.id,
      },
      sourceEventId: ref.sourceEventId,
      origin: kind === 'response' ? 'client' : 'agent',
      toolSetId: call.toolSetId,
      toolSetName: call.toolSetName,
      toolType: call.toolType,
      toolName: call.name,
      arguments: call.arguments,
      policyVersion: context.policyVersion,
      validationViolations: call.validationViolations,
    };

    return { kind, actionId: text(event.id) ?? requiredActionIdentity(event), invocation };
  });
}
