import type { CallToolRequest, CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import type { RegisteredPassthroughEvent } from '../events/PassthroughEvents';
import type { AgentInfo, ApprovalDecision, MCPServerAuthInfo, MCPServerInitInfo } from '../events/schema';
import type { InternalToolCallInfo } from '../llm/LLMTypes';
import type { SandboxInfo } from '../sandbox/Sandbox';
import type { ToolCapability } from './ToolCapabilityRegistry';

export interface MCPAuthRequired {
  servers: MCPServerAuthInfo[];
}

export type ToolSchema = ListToolsResult['tools'][number];

export interface AgentToolSchema extends ToolSchema {
  preload: boolean;
}

export interface AuthRequiredResponse {
  authRequired: MCPAuthRequired;
}

export function isAuthRequired(response: ListToolsResponse | CallToolResponse): response is AuthRequiredResponse {
  return 'authRequired' in response;
}

export interface ListToolsResolvedResponse {
  result: { tools: AgentToolSchema[] };
  wasInitialized: MCPServerInitInfo | undefined;
}

export type ListToolsResponse = ListToolsResolvedResponse | AuthRequiredResponse;

export interface CallToolResolvedResponse {
  result: CallToolResult;
  wasInitialized: MCPServerInitInfo | undefined;
  // Set to true on the call that created the sandbox; emits `sandbox.created` upstream.
  sandboxCreated?: boolean | undefined;
  // Set on every sandbox-backed call; used for tracing.
  sandboxInfo?: SandboxInfo | undefined;
  events?: readonly RegisteredPassthroughEvent[] | undefined;
}

export type CallToolResultResponse = CallToolResolvedResponse | AuthRequiredResponse;

export interface CallToolCreateSubAgentResponse {
  createSubAgent: AgentInfo;
}

export interface ApprovalRequiredResponse {
  approvalRequired: { tool_info: InternalToolCallInfo };
}

export function isApprovalRequiredResponse(response: CallToolResponse): response is ApprovalRequiredResponse {
  return 'approvalRequired' in response;
}

export interface ClientSideToolRequiredResponse {
  clientSideToolRequired: { tool_info: InternalToolCallInfo };
}

export function isClientSideToolRequiredResponse(
  response: CallToolResponse,
): response is ClientSideToolRequiredResponse {
  return 'clientSideToolRequired' in response;
}

export type CallToolResponse =
  CallToolResultResponse | CallToolCreateSubAgentResponse | ApprovalRequiredResponse | ClientSideToolRequiredResponse;

export type ToolCallPreflightResult =
  | {
      kind: 'required_action';
      response: AuthRequiredResponse | ApprovalRequiredResponse | ClientSideToolRequiredResponse;
    }
  | { kind: 'resolved'; response: CallToolResponse }
  | { kind: 'dispatch'; dispatch: () => Promise<CallToolResponse> };

export function isCallToolResponseCreateSubAgent(
  response: CallToolResponse,
): response is CallToolCreateSubAgentResponse {
  return 'createSubAgent' in response;
}

export function isCallToolResponseResult(response: CallToolResponse): response is CallToolResolvedResponse {
  return 'result' in response;
}

type CallToolResultMetadata = Omit<CallToolResolvedResponse, 'result'>;

const EMPTY_METADATA: CallToolResultMetadata = { wasInitialized: undefined };

export function toolResultResponse(params: {
  text: string;
  structuredContent?: Record<string, unknown> | undefined;
  overrides?: Partial<CallToolResultMetadata> | undefined;
  isError?: boolean | undefined;
}): CallToolResolvedResponse {
  return {
    result: {
      content: [{ type: 'text', text: params.text }],
      ...(params.structuredContent !== undefined && { structuredContent: params.structuredContent }),
      ...(params.isError && { isError: true }),
    },
    ...EMPTY_METADATA,
    ...params.overrides,
  };
}

/** Synchronous identity of the selector policy governing a tool set. Captured into tool-call info. */
export interface ToolSetPolicyIdentity {
  stable_tool_set_id: string;
  policy_id: string;
  policy_version: string;
}

/**
 * Request-aware synchronous approval target identity: the stable tool set, original tool name, and
 * governing policy that a specific call resolves to. For a direct {@link ToolSet} this is its own
 * identity plus the requested tool name. For a wrapper such as DeferredTool's `call_tool`, it is the
 * *underlying* server/tool/policy the wrapper delegates to — never the wrapper's own id/name. The
 * coordinator recomputes the durable approval binding against this target while retaining the
 * canonical full root model-argument fingerprint and the wrapper's lifecycle identity.
 */
export interface ToolApprovalTargetIdentity {
  stable_tool_set_id: string;
  original_tool_name: string;
  policy_id: string;
  policy_version: string;
}

/** Narrow public MCP server contract. Private implementations may expose additional members. */
export interface IToolSet {
  readonly name: string;
  readonly id: string;
  readonly description?: string | undefined;

  // True when every exposed tool is eager. DeferredTool uses the inverse.
  readonly preload: boolean;

  // Outcome-oriented preflight flag: Tool.ts calls listTools() initially when
  // this is true. It does not expose enable/disable/preload selector policy.
  readonly hasPreloadedTools: boolean;

  listTools(): Promise<ListToolsResponse>;

  /**
   * Synchronous governing selector-policy identity. Absence means the tool set exposes no policy
   * (e.g. an unrestricted local tool set); callers then omit the policy snapshot and derive no binding.
   */
  policyIdentity?(): ToolSetPolicyIdentity | undefined;

  /**
   * Request-aware synchronous approval target identity for a specific call. Resolves the stable tool
   * set, original tool name, and governing policy the call binds to — following wrapper delegation
   * (e.g. DeferredTool's `call_tool` resolves the underlying server/tool/policy). Absence means the
   * call exposes no bindable target (e.g. a non-`call_tool` deferred local tool) and stays unbound.
   * The coordinator recomputes the durable approval binding against this target while keeping the
   * canonical full root model-argument fingerprint and the wrapper lifecycle identity.
   */
  approvalTargetIdentity?(request: CallToolRequest['params']): ToolApprovalTargetIdentity | undefined;

  /** Host-owned execution semantics. Absence receives conservative coordinator defaults. */
  getToolCapability?(toolName: string): ToolCapability | undefined;

  /**
   * Synchronous accessor for a tool's discovered/declared JSON input schema, used by the coordinator
   * for live input-schema validation. Backed by a per-instance cache populated from the tool set's own
   * {@link listTools}/source results, so it never issues network I/O. The tool set remains the owner of
   * the discovered schema. Returns `undefined` when the schema is not (yet) known, is unavailable, or
   * the tool is unknown — the coordinator then skips validation safely rather than failing closed.
   * A {@link LocalToolMCP} returns its canonical `defineTool`-generated schema.
   */
  getToolInputSchema?(toolName: string): ToolSchema['inputSchema'] | undefined;

  prepareToolCall?(
    params: CallToolRequest['params'],
    approvalDecision?: ApprovalDecision,
  ): Promise<ToolCallPreflightResult>;

  callTool(params: CallToolRequest['params'], approvalDecision?: ApprovalDecision): Promise<CallToolResponse>;

  toolCallInfo(params: CallToolRequest['params'], resolveUnderlyingTool?: boolean): Promise<InternalToolCallInfo>;

  // Existing synchronous Code Mode allow-list. Optional implementations fall
  // back to the current unrestricted envelope; callTool still enforces policy.
  getAllowedToolNamesForSandbox?(): string[] | undefined;
}

/** Policy-free tool provider; a {@link ToolSet} wraps it to layer per-agent selector policy on top. */
export interface ToolSource {
  readonly name: string;
  readonly id: string;
  readonly description?: string | undefined;

  listTools(): Promise<ListToolsResolvedResponse | AuthRequiredResponse>;

  callTool(params: CallToolRequest['params'], approvalDecision?: ApprovalDecision): Promise<CallToolResponse>;

  toolCallInfo(params: CallToolRequest['params'], resolveUnderlyingTool?: boolean): Promise<InternalToolCallInfo>;
}
