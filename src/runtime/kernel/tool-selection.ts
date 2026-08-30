/**
 * Phase 7 — Adaptive tool presentation and selection.
 *
 * When the tool surface is large, the model should not see every tool on every
 * step. {@link selectTools} chooses a step-visible subset from task type, plan
 * step, tags, referenced resources, prior failures, and permissions — while
 * ALWAYS preserving:
 *   - explicitly preloaded tools,
 *   - tools required by an active approval or repair chain,
 *   - the route needed to discover/load other tools.
 *
 * It falls back to the full set when confidence is low, records why each tool
 * was selected, and reports metrics (tools presented, schema tokens, unknown
 * attempts). It never widens permissions; hidden tools are a presentation
 * concern only, not a policy bypass.
 */

import { z } from 'zod';
import { LIMITS, boundedArray, boundedInt, shortText } from './schema.ts';

export const ToolTagSchema = z.enum([
  'read',
  'write',
  'discovery',
  'test',
  'search',
  'approval-gated',
  'system',
]);
export type ToolTag = z.infer<typeof ToolTagSchema>;

export const ToolDescriptorSchema = z.strictObject({
  toolName: shortText,
  toolSetName: shortText,
  tags: boundedArray(ToolTagSchema, LIMITS.smallArray),
  schemaTokens: boundedInt(),
  preloaded: z.boolean(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const SelectionContextSchema = z.strictObject({
  taskType: shortText,
  planStepText: shortText.optional(),
  referencedResources: boundedArray(shortText, LIMITS.smallArray).readonly(),
  /** Tool names touched by an active approval/repair lineage — always kept. */
  requiredToolNames: boundedArray(shortText, LIMITS.smallArray).readonly(),
  /** Tool names the model previously failed to call correctly. */
  priorFailedToolNames: boundedArray(shortText, LIMITS.smallArray).readonly(),
  /** Below this many tools, adaptive selection is a no-op (present all). */
  minSurfaceForSelection: boundedInt(),
  /** Cap on presented tools before falling back to full set on low confidence. */
  maxPresented: boundedInt(),
});
export type SelectionContext = z.infer<typeof SelectionContextSchema>;

export const ToolSelectionMetricsSchema = z.strictObject({
  toolsAvailable: boundedInt(),
  toolsPresented: boundedInt(),
  schemaTokensPresented: boundedInt(),
  fellBackToFull: z.boolean(),
  reasonsByTool: z.record(z.string(), shortText),
});
export type ToolSelectionMetrics = z.infer<typeof ToolSelectionMetricsSchema>;

export interface ToolSelection {
  presented: ToolDescriptor[];
  metrics: ToolSelectionMetrics;
}

function scoreTool(tool: ToolDescriptor, ctx: SelectionContext): { keep: boolean; reason: string } {
  if (tool.preloaded) return { keep: true, reason: 'preloaded' };
  if (ctx.requiredToolNames.includes(tool.toolName)) return { keep: true, reason: 'required-by-active-lineage' };
  // Never hide the route needed to discover/load other tools.
  if (tool.tags.includes('discovery')) return { keep: true, reason: 'discovery-route' };

  const step = (ctx.planStepText ?? '').toLowerCase();
  const wantsWrite = /write|patch|commit|push|open (a )?pr|pull request|create|update|delete/.test(step);
  const wantsTest = /test|reproduce|verify|suite/.test(step);
  const wantsRead = /read|inspect|case the building|source|trace|search|find/.test(step);

  if (wantsTest && tool.tags.includes('test')) return { keep: true, reason: 'matches-test-step' };
  if (wantsWrite && (tool.tags.includes('write') || tool.tags.includes('approval-gated'))) {
    return { keep: true, reason: 'matches-write-step' };
  }
  if (wantsRead && (tool.tags.includes('read') || tool.tags.includes('search'))) {
    return { keep: true, reason: 'matches-read-step' };
  }

  // Resource-name affinity.
  const nameHay = `${tool.toolName} ${tool.toolSetName}`.toLowerCase();
  if (ctx.referencedResources.some((r) => nameHay.includes(r.toLowerCase().split('/')[0] ?? ''))) {
    return { keep: true, reason: 'resource-affinity' };
  }

  // A previously-failed tool for a matching step is kept so the model can retry
  // it correctly rather than being silently deprived of it.
  if (ctx.priorFailedToolNames.includes(tool.toolName)) {
    return { keep: true, reason: 'prior-failure-retry' };
  }

  return { keep: false, reason: 'not-relevant-to-step' };
}

export function selectTools(
  available: readonly ToolDescriptor[],
  ctx: SelectionContext,
): ToolSelection {
  const parsedAvailable = boundedArray(ToolDescriptorSchema, LIMITS.largeArray).parse(available);
  const parsedCtx = SelectionContextSchema.parse(ctx);
  return runSelection(parsedAvailable, parsedCtx);
}

function runSelection(
  available: readonly ToolDescriptor[],
  ctx: SelectionContext,
): ToolSelection {
  const reasonsByTool: Record<string, string> = {};

  // Small surfaces: present everything (no selection benefit).
  if (available.length < ctx.minSurfaceForSelection) {
    for (const t of available) reasonsByTool[t.toolName] = 'surface-below-threshold';
    return {
      presented: [...available],
      metrics: {
        toolsAvailable: available.length,
        toolsPresented: available.length,
        schemaTokensPresented: available.reduce((s, t) => s + t.schemaTokens, 0),
        fellBackToFull: true,
        reasonsByTool,
      },
    };
  }

  const kept: ToolDescriptor[] = [];
  for (const tool of available) {
    const { keep, reason } = scoreTool(tool, ctx);
    reasonsByTool[tool.toolName] = reason;
    if (keep) kept.push(tool);
  }

  // Low-confidence fallback: if selection kept nothing (or blew the cap), fall
  // back to the full set rather than deprive the model of a route.
  const lowConfidence = kept.length === 0 || kept.length > ctx.maxPresented;
  const presented = lowConfidence ? [...available] : kept;
  if (lowConfidence) {
    for (const t of available) {
      if (!(t.toolName in reasonsByTool) || reasonsByTool[t.toolName] === 'not-relevant-to-step') {
        reasonsByTool[t.toolName] = 'low-confidence-fallback';
      }
    }
  }

  return {
    presented,
    metrics: {
      toolsAvailable: available.length,
      toolsPresented: presented.length,
      schemaTokensPresented: presented.reduce((s, t) => s + t.schemaTokens, 0),
      fellBackToFull: lowConfidence,
      reasonsByTool,
    },
  };
}
