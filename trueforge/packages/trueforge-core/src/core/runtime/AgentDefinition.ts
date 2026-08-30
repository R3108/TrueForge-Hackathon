import type { ModelSetConfig } from '../capabilities/builtins/DynamicSubAgents';
import type { WebSearchProvider } from '../capabilities/builtins/WebSearch';
import type { ILLM } from '../llm/ILLM';
import type { LLMUserMessage } from '../llm/LLMTypes';
import type { ResponseFormat } from '../llm/responseFormat';
import type { IToolSet } from '../mcp/IMCPServer';
import type { NoProgressOverride } from '../mcp/NoProgressController';

export type ModelParams = Record<string, unknown>;

/**
 * Static definition of an agent. Represents the authored configuration,
 * not the execution state. Inherited by sub-agent definitions.
 *
 * Model identity lives on `modelClient` (e.g. VercelAILLM providerConfig),
 * not as a parallel string on this definition.
 */
export interface AgentDefinition {
  modelClient: ILLM;
  modelProperties?:
    | {
        /** Maximum combined input/output context for the resolved model, when known. */
        contextLength: number | undefined;
        /** Host-advertised reasoning efforts accepted by this model, when known. */
        reasoningEfforts?: readonly string[] | undefined;
      }
    | undefined;
  instruction?: string | undefined;
  messages?: readonly LLMUserMessage[] | undefined;
  modelParams?: ModelParams | undefined;
  /** Same wire shape as AgentSpec.response_format (Zod ResponseFormat). */
  responseFormat?: ResponseFormat | undefined;
  iterationLimit?: number | undefined;

  /**
   * Live no-progress enforcement override. Fixed-core and default-on: `undefined`/`true` keep safe
   * defaults, `false` disables it, and a validated partial object overrides thresholds/history limit
   * (still ordered `reminder < replan < stop`). Safe defaults always apply for anything omitted.
   */
  noProgress?: NoProgressOverride | undefined;

  /** Host-configured real-time web search. Credentials remain in the host provider implementation. */
  webSearchProvider?: WebSearchProvider | undefined;

  /** Host-owned configured model catalog offered to the dynamic subagent tool. */
  dynamicSubAgentModels?: ModelSetConfig | undefined;

  toolSets?: readonly IToolSet[] | undefined;
}
