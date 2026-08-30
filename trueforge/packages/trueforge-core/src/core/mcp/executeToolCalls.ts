import type { RegisteredPassthroughEvent } from '../events/PassthroughEvents';
import type { MCPServerInitInfo } from '../events/schema';
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall, LLMToolMessage } from '../llm/LLMTypes';
import type { MCPAuthRequired } from '../mcp/IMCPServer';
import type { AgentThreadCreateSubAgent } from '../runtime/AgentThread.types';
import { InternalEventType } from '../runtime/AgentThread.types';
import type { ApprovalDecisionRecord } from '../runtime/contextUtils';
import type { SandboxInfo } from '../sandbox/Sandbox';
import type { MappedMCPTool } from './convertMCPServers';
import {
  isApprovalRequiredResponse,
  isAuthRequired,
  isCallToolResponseCreateSubAgent,
  isClientSideToolRequiredResponse,
} from './IMCPServer';
import {
  DEFAULT_TOOL_EXECUTION_COORDINATOR,
  type ToolExecutionContext,
  type ToolExecutionCoordinator,
} from './ToolExecutionCoordinator';

export interface ToolCallResult {
  message: LLMToolMessage;
  // Absent only for unknown-tool calls (LLM hallucinated a name not in toolMapping):
  // there is no backing MCP server. Downstream consumers (e.g. LargeToolResponse)
  // gate on `failure: false` before reading `info`, so the absence is naturally
  // short-circuited on the success path.
  info?: MappedMCPTool | undefined;
  failure: boolean;
  isStructuredContent: boolean;
  completedAt: string;
}

export interface ExecuteToolCallsResult {
  toolCallResults: ToolCallResult[];
  initializationInfo: MCPServerInitInfo[];
  createThreadEvents: AgentThreadCreateSubAgent[];
  sandboxCreated: SandboxInfo | undefined;
  authRequirementInfo: MCPAuthRequired[];
  approvalRequiredToolCalls: InternalEnrichedToolCall[];
  clientSideToolCalls: InternalEnrichedToolCall[];
  events: RegisteredPassthroughEvent[];
}

function defaultExecutionContext(input: { threadId: string; signal: AbortSignal | undefined }): ToolExecutionContext {
  return {
    session_id: null,
    turn_id: null,
    thread_id: input.threadId,
    model_message_id: null,
    root_tool_call_id: null,
    parent_tool_call_id: null,
    signal: input.signal,
    event_recorder: undefined,
  };
}

export async function executeToolCalls({
  assistantMessage,
  toolMapping,
  threadId,
  approvalDecisions,
  coordinator = DEFAULT_TOOL_EXECUTION_COORDINATOR,
  signal,
  executionContext,
}: {
  assistantMessage: InternalEnrichedAssistantMessage;
  toolMapping: Map<string, MappedMCPTool>;
  threadId: string;
  approvalDecisions: Map<string, ApprovalDecisionRecord>;
  coordinator?: ToolExecutionCoordinator | undefined;
  signal?: AbortSignal | undefined;
  executionContext?: ToolExecutionContext | undefined;
}): Promise<ExecuteToolCallsResult> {
  const toolMessages: ToolCallResult[] = [];
  const initializationInfo: MCPServerInitInfo[] = [];
  const createThreadEvents: AgentThreadCreateSubAgent[] = [];
  const authRequirementInfo: MCPAuthRequired[] = [];
  const approvalRequiredToolCalls: InternalEnrichedToolCall[] = [];
  const clientSideToolCalls: InternalEnrichedToolCall[] = [];
  const passthroughEvents: RegisteredPassthroughEvent[] = [];
  let sandboxCreated: SandboxInfo | undefined;

  if (!assistantMessage.tool_calls) {
    return {
      toolCallResults: toolMessages,
      initializationInfo,
      createThreadEvents,
      sandboxCreated,
      authRequirementInfo,
      approvalRequiredToolCalls,
      clientSideToolCalls,
      events: passthroughEvents,
    };
  }

  // Decode and classify the whole model batch before any member can dispatch.
  const modelMessageId = assistantMessage.model_message_id ?? executionContext?.model_message_id ?? null;
  const batch = await coordinator.prepareBatch({
    invocations: assistantMessage.tool_calls.map(toolCall => {
      const info = toolMapping.get(toolCall.function.name);
      const record = approvalDecisions.get(toolCall.id);
      return {
        tool_call_id: toolCall.id,
        tool_set: info?.toolSet,
        tool_name: info?.originalToolName ?? toolCall.function.name,
        arguments: toolCall.function.arguments,
        approval_decision: record?.decision,
        approval_binding: record?.binding,
        model_message_id: modelMessageId,
      };
    }),
    context: executionContext ?? defaultExecutionContext({ threadId, signal }),
  });
  const outcomes = await coordinator.executeBatch({ batch, signal });

  for (let index = 0; index < outcomes.length; index++) {
    const outcome = outcomes[index];
    const toolCall = assistantMessage.tool_calls[index];
    if (!outcome || !toolCall) {
      throw new Error('Tool coordinator result ordering did not match the model tool-call batch.');
    }
    const toolInfo = toolMapping.get(toolCall.function.name);
    const response = outcome.response;

    if (isCallToolResponseCreateSubAgent(response)) {
      createThreadEvents.push({
        type: InternalEventType.AGENT_CREATE_SUBAGENT,
        thread_id: threadId,
        tool_call_id: toolCall.id,
        agent_info: response.createSubAgent,
      });
      continue;
    }

    if (isAuthRequired(response)) {
      authRequirementInfo.push(response.authRequired);
      // Must still emit a tool result so every tool_call in the assistant message has a
      // matching tool_result in context; otherwise the LLM API rejects the conversation.
      toolMessages.push({
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'Waiting for user to authenticate. Please try again 1 time.',
        },
        failure: true,
        info: toolInfo,
        isStructuredContent: false,
        completedAt: outcome.completed_at,
      });
      continue;
    }

    if (isApprovalRequiredResponse(response)) {
      approvalRequiredToolCalls.push(toolCall);
      continue;
    }

    if (isClientSideToolRequiredResponse(response)) {
      clientSideToolCalls.push(toolCall);
      continue;
    }

    const { result, wasInitialized } = response;

    let content: string;
    let isStructuredContent = false;
    if (result.isError) {
      content = JSON.stringify({ error: result.content });
    } else if (result.structuredContent) {
      isStructuredContent = true;
      content = JSON.stringify(result.structuredContent);
    } else if (Array.isArray(result.content)) {
      const textContent = result.content
        .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
        .map(item => item.text)
        .join('\n');
      content = textContent || JSON.stringify(result.content);
    } else {
      content = JSON.stringify(result.content);
    }

    toolMessages.push({
      message: { role: 'tool', tool_call_id: toolCall.id, content },
      // Returned MCP domain errors remain ordinary tool results for downstream
      // response offloading; the coordinator outcome still records status=failed.
      failure: outcome.failure_class === 'domain' ? false : outcome.failure,
      info: toolInfo,
      isStructuredContent,
      completedAt: outcome.completed_at,
    });
    if (wasInitialized) {
      initializationInfo.push(wasInitialized);
    }
    if (response.sandboxCreated && response.sandboxInfo) {
      sandboxCreated = response.sandboxInfo;
    }
    if (response.events?.length) {
      passthroughEvents.push(...response.events);
    }
  }

  return {
    toolCallResults: toolMessages,
    initializationInfo,
    createThreadEvents,
    sandboxCreated,
    authRequirementInfo,
    approvalRequiredToolCalls,
    clientSideToolCalls,
    events: passthroughEvents,
  };
}
