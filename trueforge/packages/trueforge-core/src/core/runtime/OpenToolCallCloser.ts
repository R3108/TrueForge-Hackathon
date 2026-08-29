/**
 * OpenToolCallCloser - Context processor that closes unresolved tool calls.
 *
 * When an assistant message contains tool_calls but corresponding tool response
 * messages are missing (e.g., due to a failed or interrupted tool execution),
 * LLMs will reject the request. This processor detects such cases in the
 * **last** assistant message and appends dummy tool responses so the
 * conversation can continue.
 *
 * Uses is_thread_creation from InternalToolCallInfo to identify sub-agent
 * tool calls (which should remain open); does NOT use SUB_AGENTS_SERVER_ID.
 * Older persisted contexts without is_thread_creation follow the ordinary
 * non-thread-creation path (no compatibility fallback).
 */
import type {
  AgentContextProcessorAppendContext,
  AgentThreadExecutionContext,
  PreSendContextProcessor,
} from '../capabilities/AgentContextProcessor';
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall, LLMToolMessage } from '../llm/LLMTypes';
import type { ToolRecoveryDecision } from '../mcp/ProgressAndRecoveryController';
import type { ContextMessage } from './AgentThread.types';
import { InternalEventType } from './AgentThread.types';
import { mergeCurrentContextUsage } from './contextUsage';
import { estimateTokensForContextMessages, isLLMContextMessage } from './contextUtils';

const LEGACY_DUMMY_TOOL_MESSAGE_CONTENT = JSON.stringify({
  error: 'Tool call was not executed. Please retry this tool call.',
});

function recoveryToolMessage(decision: ToolRecoveryDecision | undefined): string {
  if (decision === undefined) {
    return LEGACY_DUMMY_TOOL_MESSAGE_CONTENT;
  }
  return JSON.stringify({
    error: 'interrupted_tool_execution',
    recovery_disposition: decision.disposition,
    automatic_retry_allowed: decision.automatic_retry_allowed,
    completion_unknown: decision.completion_unknown,
    attempts_observed: decision.attempts_observed,
    message: decision.reason,
  });
}

function getOpenToolCallsOnLastAssistant(context: ContextMessage[]): readonly InternalEnrichedToolCall[] {
  const lastIdx = context.findLastIndex(
    (msg): msg is InternalEnrichedAssistantMessage =>
      isLLMContextMessage(msg) && msg.role === 'assistant' && !!msg.tool_calls?.length,
  );
  if (lastIdx === -1) {
    return [];
  }

  const lastAssistant = context[lastIdx];
  if (lastAssistant === undefined || !isLLMContextMessage(lastAssistant) || lastAssistant.role !== 'assistant') {
    throw new Error('Unreachable');
  }
  if (!lastAssistant.tool_calls) {
    return [];
  }

  const answeredIds = new Set<string>();
  for (const msg of context.slice(lastIdx + 1)) {
    if (isLLMContextMessage(msg) && msg.role === 'tool') {
      answeredIds.add(msg.tool_call_id);
    }
  }
  return lastAssistant.tool_calls.filter(toolCall => !answeredIds.has(toolCall.id));
}

export function getClosableOpenToolCallIds(context: ContextMessage[]): Set<string> {
  return new Set(
    getOpenToolCallsOnLastAssistant(context)
      .filter(
        toolCall =>
          toolCall.tool_info.is_approval_required !== true &&
          toolCall.tool_info.is_client_side !== true &&
          toolCall.tool_info.is_thread_creation !== true,
      )
      .map(toolCall => toolCall.id),
  );
}

function getRecoveryClosableToolCallIds(
  context: ContextMessage[],
  decisions: ReadonlyMap<string, ToolRecoveryDecision>,
): Set<string> {
  return new Set(
    getOpenToolCallsOnLastAssistant(context)
      .filter(
        toolCall =>
          decisions.has(toolCall.id) &&
          toolCall.tool_info.is_approval_required !== true &&
          toolCall.tool_info.is_client_side !== true &&
          toolCall.tool_info.is_thread_creation !== true,
      )
      .map(toolCall => toolCall.id),
  );
}

export class OpenToolCallCloser implements PreSendContextProcessor {
  private readonly recoveryDecisions: ReadonlyMap<string, ToolRecoveryDecision>;

  constructor(options: { recovery_decisions?: ReadonlyMap<string, ToolRecoveryDecision> | undefined } = {}) {
    this.recoveryDecisions = options.recovery_decisions ?? new Map();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async *: AsyncIterable contract; body is sync
  async *processPreSend(
    execution: Readonly<AgentThreadExecutionContext>,
  ): AsyncGenerator<AgentContextProcessorAppendContext, void, unknown> {
    const requestedIds = getClosableOpenToolCallIds(execution.context);
    for (const toolCallId of getRecoveryClosableToolCallIds(execution.context, this.recoveryDecisions)) {
      requestedIds.add(toolCallId);
    }
    if (requestedIds.size === 0) {
      return;
    }

    const dummyToolMessages: LLMToolMessage[] = [...requestedIds].map(toolCallId => ({
      role: 'tool',
      tool_call_id: toolCallId,
      content: recoveryToolMessage(this.recoveryDecisions.get(toolCallId)),
    }));

    const currentContextUsage = mergeCurrentContextUsage(
      execution.currentContextUsage,
      estimateTokensForContextMessages(dummyToolMessages),
    );

    yield {
      type: InternalEventType.AGENT_CONTEXT_APPEND,
      context: dummyToolMessages,
      output: [],
      current_context_usage: currentContextUsage,
    };
  }
}
