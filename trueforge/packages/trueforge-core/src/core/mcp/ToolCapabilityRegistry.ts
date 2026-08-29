import { z } from 'zod';

export const SideEffectClassSchema = z.enum(['read_only', 'workspace_write', 'remote_write', 'destructive', 'unknown']);

export const RetryCapabilitySchema = z.enum(['safe', 'native_idempotency', 'reconcile_before_retry', 'never']);

export const ToolConcurrencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('parallel_safe') }),
  z.object({ kind: z.literal('exclusive') }),
  z.object({ kind: z.literal('resource_scoped'), resources: z.array(z.string().min(1)) }),
]);

export const ToolCapabilitySemanticsSchema = z.object({
  side_effect_class: SideEffectClassSchema,
  retry_capability: RetryCapabilitySchema,
  concurrency: ToolConcurrencySchema,
  timeout_ms: z.number().int().positive().nullable(),
  output_schema: z.unknown().nullable(),
  result_size_class: z.enum(['small', 'medium', 'large', 'unknown']),
  evidence_capabilities: z.array(z.string()),
  sensitive_argument_paths: z.array(z.string()),
  tags: z.array(z.string()),
});

export const ToolCapabilityDefinitionSchema = z.object({
  tool_name: z.string().min(1),
  ...ToolCapabilitySemanticsSchema.shape,
});

export const ToolCapabilitySchema = z.object({
  stable_tool_set_id: z.string().min(1),
  ...ToolCapabilityDefinitionSchema.shape,
});

export type SideEffectClass = z.infer<typeof SideEffectClassSchema>;
export type RetryCapability = z.infer<typeof RetryCapabilitySchema>;
export type ToolConcurrency = z.infer<typeof ToolConcurrencySchema>;
export type ToolCapabilitySemantics = z.infer<typeof ToolCapabilitySemanticsSchema>;
export type ToolCapabilityDefinition = z.infer<typeof ToolCapabilityDefinitionSchema>;
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

export function bindToolCapability(input: {
  stable_tool_set_id: string;
  definition: ToolCapabilityDefinition;
}): ToolCapability {
  return ToolCapabilitySchema.parse({
    stable_tool_set_id: input.stable_tool_set_id,
    ...input.definition,
  });
}

function capabilityKey(input: { stableToolSetId: string; toolName: string }): string {
  return `${input.stableToolSetId}\u0000${input.toolName}`;
}

function conservativeCapability(input: { stableToolSetId: string; toolName: string }): ToolCapability {
  return {
    stable_tool_set_id: input.stableToolSetId,
    tool_name: input.toolName,
    side_effect_class: 'unknown',
    retry_capability: 'never',
    concurrency: { kind: 'exclusive' },
    timeout_ms: null,
    output_schema: null,
    result_size_class: 'unknown',
    evidence_capabilities: [],
    sensitive_argument_paths: [],
    tags: [],
  };
}

/** Host-owned execution semantics. Server-provided annotations never mutate this registry. */
export class ToolCapabilityRegistry {
  private readonly capabilities = new Map<string, ToolCapability>();

  constructor(capabilities: readonly ToolCapability[] = []) {
    for (const capability of capabilities) {
      this.register(capability);
    }
  }

  register(input: ToolCapability): void {
    const capability = ToolCapabilitySchema.parse(input);
    this.capabilities.set(
      capabilityKey({
        stableToolSetId: capability.stable_tool_set_id,
        toolName: capability.tool_name,
      }),
      capability,
    );
  }

  resolve(input: {
    stableToolSetId: string;
    toolName: string;
    hostCapability: ToolCapability | undefined;
  }): ToolCapability {
    const registered = this.capabilities.get(capabilityKey(input));
    if (registered !== undefined) {
      return registered;
    }
    if (input.hostCapability !== undefined) {
      const parsed = ToolCapabilitySchema.safeParse(input.hostCapability);
      if (
        parsed.success &&
        parsed.data.stable_tool_set_id === input.stableToolSetId &&
        parsed.data.tool_name === input.toolName
      ) {
        return parsed.data;
      }
    }
    return conservativeCapability({ stableToolSetId: input.stableToolSetId, toolName: input.toolName });
  }
}
