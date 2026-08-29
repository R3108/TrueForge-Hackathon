import type { CallToolRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { McpConnectionError } from '../errors';
import type { ApprovalDecision } from '../events/schema';
import type { InternalToolCallInfo } from '../llm/LLMTypes';
import {
  isAuthRequired,
  isCallToolResponseResult,
  toolResultResponse,
  type AgentToolSchema,
  type CallToolResponse,
  type IToolSet,
  type ListToolsResponse,
  type ToolApprovalTargetIdentity,
  type ToolCallPreflightResult,
  type ToolSchema,
  type ToolSetPolicyIdentity,
  type ToolSource,
} from './IMCPServer';
import {
  bindToolCapability,
  ToolCapabilityDefinitionSchema,
  type ToolCapability,
  type ToolCapabilityDefinition,
} from './ToolCapabilityRegistry';
import { ToolSelectorPolicy, type ToolSelectorConfig } from './ToolSelectorPolicy';

/**
 * Per-agent {@link IToolSet} view over a shared, policy-free {@link ToolSource}, applying the
 * enable/disable/preload/approval selectors. Many can wrap one source without policy bleed.
 */
export class ToolSet implements IToolSet {
  readonly name: string;
  readonly id: string;
  readonly description?: string | undefined;
  readonly preload: boolean;
  readonly hasPreloadedTools: boolean;

  private readonly source: ToolSource;
  private readonly policy: ToolSelectorPolicy;
  private readonly capabilities = new Map<string, ToolCapability>();
  /**
   * Per-instance cache of discovered tool input schemas, keyed by original tool name. Populated as a
   * side effect of every source `listTools` this view performs. Instance-scoped so many {@link ToolSet}
   * views over one shared {@link ToolSource} never share cached schemas — matching the policy-isolation
   * guarantee. Read synchronously by {@link getToolInputSchema} for coordinator input validation.
   */
  private readonly inputSchemas = new Map<string, ToolSchema['inputSchema']>();

  constructor(params: {
    source: ToolSource;
    selectors: ToolSelectorConfig;
    preload: boolean;
    capabilities?: readonly ToolCapabilityDefinition[] | undefined;
  }) {
    this.source = params.source;
    this.name = params.source.name;
    this.id = params.source.id;
    this.description = params.source.description;
    this.policy = new ToolSelectorPolicy({
      selectors: params.selectors,
      preload: params.preload,
    });
    this.preload = this.policy.preload;
    this.hasPreloadedTools = this.policy.hasPreloadedTools;
    for (const input of params.capabilities ?? []) {
      const definition = ToolCapabilityDefinitionSchema.parse(input);
      this.capabilities.set(definition.tool_name, bindToolCapability({ stable_tool_set_id: this.id, definition }));
    }
  }

  getToolCapability(toolName: string): ToolCapability | undefined {
    return this.capabilities.get(toolName);
  }

  /**
   * Synchronous accessor for a tool's discovered input schema. Returns a cached schema populated by a
   * prior source `listTools` on this view, or `undefined` when not yet discovered. Never issues I/O.
   * The coordinator reads this before dispatch; a `prepareToolCall` (which lists) runs first on the
   * dispatch path, so by the time a call is executed the schema is populated for that tool.
   */
  getToolInputSchema(toolName: string): ToolSchema['inputSchema'] | undefined {
    return this.inputSchemas.get(toolName);
  }

  /** Populate the per-instance input-schema cache from a resolved source tool list. */
  private cacheInputSchemas(tools: readonly AgentToolSchema[]): void {
    for (const tool of tools) {
      this.inputSchemas.set(tool.name, tool.inputSchema);
    }
  }

  /** Synchronous identity of the selector policy this view applies. Stable across a turn. */
  policyIdentity(): ToolSetPolicyIdentity {
    return {
      stable_tool_set_id: this.id,
      policy_id: this.id,
      policy_version: this.policy.version,
    };
  }

  /**
   * Request-aware approval target identity for a direct call: this view's own stable identity and
   * governing policy, paired with the requested tool name. A {@link ToolSet} is the leaf policy owner,
   * so the target is simply its {@link policyIdentity} plus `request.name`.
   */
  approvalTargetIdentity(request: CallToolRequest['params']): ToolApprovalTargetIdentity {
    return {
      stable_tool_set_id: this.id,
      original_tool_name: request.name,
      policy_id: this.id,
      policy_version: this.policy.version,
    };
  }

  getAllowedToolNamesForSandbox(): string[] | undefined {
    return this.policy.allowedNamesForSandbox();
  }

  async listTools(): Promise<ListToolsResponse> {
    const response = await this.source.listTools();
    if (isAuthRequired(response)) {
      return response;
    }

    const tools = response.result.tools;
    this.cacheInputSchemas(tools);
    const missingTools = this.policy.missingEnableLiterals(tools);
    if (missingTools.length > 0) {
      throw new McpConnectionError(
        `Requested tools not found in MCP server ${this.name}: ${missingTools.join(', ')}`,
        422,
      );
    }

    return {
      result: { tools: this.policy.filterAndAnnotate(tools) },
      wasInitialized: response.wasInitialized,
    };
  }

  async prepareToolCall(
    params: CallToolRequest['params'],
    decision?: ApprovalDecision,
  ): Promise<ToolCallPreflightResult> {
    // Prime the source and surface auth-required before the annotation-based allow/approval checks
    // (which would otherwise see missing annotations and wrongly 403).
    const listed = await this.source.listTools();
    if (isAuthRequired(listed)) {
      return { kind: 'required_action', response: listed };
    }
    this.cacheInputSchemas(listed.result.tools);
    const annotations = findAnnotations(listed.result.tools, params.name);

    await this.assertToolAllowed(params.name, annotations);

    const tool_info = await this.buildToolCallInfo(params, annotations);
    if (!decision && tool_info.is_approval_required) {
      return { kind: 'required_action', response: { approvalRequired: { tool_info } } };
    }

    if (decision?.status === 'deny') {
      const reason = decision.reason ?? 'no reason provided';
      return {
        kind: 'resolved',
        response: toolResultResponse({
          text: JSON.stringify({ error: `User denied tool call: ${reason}` }),
          isError: true,
        }),
      };
    }

    return {
      kind: 'dispatch',
      dispatch: async () => {
        const response = await this.source.callTool(params, decision);
        // The priming listTools() may have captured the first-connect init; carry it forward since the
        // subsequent callTool sees an already-open connection and reports none.
        if (listed.wasInitialized && isCallToolResponseResult(response) && !response.wasInitialized) {
          return { ...response, wasInitialized: listed.wasInitialized };
        }
        return response;
      },
    };
  }

  async callTool(params: CallToolRequest['params'], decision?: ApprovalDecision): Promise<CallToolResponse> {
    const prepared = await this.prepareToolCall(params, decision);
    return prepared.kind === 'dispatch' ? prepared.dispatch() : prepared.response;
  }

  async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    const annotations = await this.resolveAnnotations(params.name);
    return this.buildToolCallInfo(params, annotations, resolveUnderlyingTool);
  }

  private async assertToolAllowed(toolName: string, annotations: ToolAnnotations | undefined): Promise<void> {
    const allowed = await this.policy.isAllowed(toolName, () => Promise.resolve(annotations));
    if (!allowed) {
      throw new McpConnectionError(`Tool '${toolName}' is not allowed on MCP server ${this.name}`, 403);
    }
  }

  private async buildToolCallInfo(
    params: CallToolRequest['params'],
    annotations: ToolAnnotations | undefined,
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    return {
      ...(await this.source.toolCallInfo(params, resolveUnderlyingTool)),
      is_approval_required: this.policy.requiresApproval(params.name, annotations),
      policy_identity: this.policyIdentity(),
    };
  }

  private async resolveAnnotations(toolName: string): Promise<ToolAnnotations | undefined> {
    const listed = await this.source.listTools();
    if (isAuthRequired(listed)) {
      return undefined;
    }
    this.cacheInputSchemas(listed.result.tools);
    return findAnnotations(listed.result.tools, toolName);
  }
}

function findAnnotations(tools: AgentToolSchema[], toolName: string): ToolAnnotations | undefined {
  return tools.find(t => t.name === toolName)?.annotations;
}
