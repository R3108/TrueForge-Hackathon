/**
 * Phase 10 + Phase 3 — Provenance-aware prompt assembly and a deterministic
 * context budget plan.
 *
 * Prompt sections are ordered, each with a stable id, provenance, priority,
 * token estimate, and redaction policy. User/repository content can never
 * override core policy sections (they carry lower priority and are placed after
 * the safety sections). The final assembled prompt is inspectable with secrets
 * redacted.
 *
 * The {@link ContextBudgetPlan} divides the model context window into pinned,
 * recent-tail, relevant-history, and tool-schema budgets. It is derived only
 * from durable inputs so it is deterministic and testable, and it integrates
 * with the existing SDK compaction (which still runs on the conversation tail).
 */

import { z } from 'zod';
import { LIMITS, boundedArray, boundedInt, idString, text } from './schema.ts';

export const SectionProvenanceSchema = z.enum([
  'core-policy',
  'core-tools',
  'task-contract',
  'working-state',
  'plan-step',
  'environment',
  'project-instructions',
  'tool-guidance',
  'verification',
  'recovery',
  'user-input',
]);
export type SectionProvenance = z.infer<typeof SectionProvenanceSchema>;

export const PromptSectionSchema = z.strictObject({
  id: idString,
  provenance: SectionProvenanceSchema,
  /** Lower number = earlier and higher precedence. Core policy is 0. */
  priority: boundedInt(),
  text: text,
  /** Whether user/repository content may override this section. Core = false. */
  overridable: z.boolean(),
  redact: z.boolean(),
});
export type PromptSection = z.infer<typeof PromptSectionSchema>;

/** Canonical section order. Core safety precedes everything model-influenced. */
const ORDER: SectionProvenance[] = [
  'core-policy',
  'core-tools',
  'task-contract',
  'working-state',
  'plan-step',
  'environment',
  'project-instructions',
  'tool-guidance',
  'verification',
  'recovery',
  'user-input',
];

const SECRET_PATTERN = /(secret|token|password|api[_-]?key|credential|bearer)\S*/gi;

function estimateTokens(text: string): number {
  // Deterministic ~4 chars/token heuristic; adequate for budgeting/tests.
  return Math.ceil(text.length / 4);
}

export function makeSection(
  id: string,
  provenance: SectionProvenance,
  text: string,
  opts: { redact?: boolean } = {},
): PromptSection {
  const isCore = provenance === 'core-policy' || provenance === 'core-tools';
  return {
    id,
    provenance,
    priority: ORDER.indexOf(provenance),
    text,
    overridable: !isCore,
    redact: opts.redact ?? false,
  };
}

/**
 * Order and deduplicate sections. Sections are sorted by priority (core first);
 * duplicate normalized bodies are dropped, keeping the highest-precedence copy.
 */
export function orderSections(sections: readonly PromptSection[]): PromptSection[] {
  const sorted = [...sections].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const seenBodies = new Set<string>();
  const out: PromptSection[] = [];
  for (const section of sorted) {
    const key = section.text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (key.length > 0 && seenBodies.has(key)) continue;
    if (key.length > 0) seenBodies.add(key);
    out.push(section);
  }
  return out;
}

/** Assemble ordered sections into one prompt, redacting where required. */
export function assemblePrompt(sections: readonly PromptSection[]): string {
  return orderSections(sections)
    .map((section) => {
      const body = section.redact ? section.text.replace(SECRET_PATTERN, '$1[redacted]') : section.text;
      return `## [${section.provenance}] ${section.id}\n${body}`;
    })
    .join('\n\n');
}

export const AssembledPromptDebugSchema = z.strictObject({
  sections: boundedArray(
    z.strictObject({
      id: idString,
      provenance: SectionProvenanceSchema,
      priority: boundedInt(),
      tokenEstimate: boundedInt(),
      overridable: z.boolean(),
    }),
    LIMITS.mediumArray,
  ),
  totalTokenEstimate: boundedInt(),
});
export type AssembledPromptDebug = z.infer<typeof AssembledPromptDebugSchema>;

/** Inspectable, secret-free view of the assembled prompt for debug mode. */
export function debugPrompt(sections: readonly PromptSection[]): AssembledPromptDebug {
  const ordered = orderSections(sections);
  const view = ordered.map((s) => ({
    id: s.id,
    provenance: s.provenance,
    priority: s.priority,
    tokenEstimate: estimateTokens(s.text),
    overridable: s.overridable,
  }));
  return {
    sections: view,
    totalTokenEstimate: view.reduce((sum, s) => sum + s.tokenEstimate, 0),
  };
}

export const ContextBudgetPlanSchema = z.strictObject({
  contextWindow: boundedInt(1),
  reservedOutputTokens: boundedInt(),
  pinnedBudget: boundedInt(),
  recentTailBudget: boundedInt(),
  relevantHistoryBudget: boundedInt(),
  toolSchemaBudget: boundedInt(),
  safetyMargin: boundedInt(),
});
export type ContextBudgetPlan = z.infer<typeof ContextBudgetPlanSchema>;

export const ModelLimitsSchema = z.strictObject({
  contextWindow: boundedInt(1),
  maxOutputTokens: boundedInt(),
});
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

/**
 * Deterministically divide a model's context window into category budgets.
 * Recomputed whenever the model (limits) change, so a model switch recalculates
 * budgets. Pinned context (contract + working state + active approvals + errors)
 * is protected first; the recent tail and tool schemas are budgeted next; the
 * remainder goes to relevant history.
 */
export function planContextBudget(
  limits: ModelLimits,
  pinnedTokenEstimate: number,
): ContextBudgetPlan {
  const parsedLimits = ModelLimitsSchema.parse(limits);
  const contextWindow = Math.max(1, parsedLimits.contextWindow);
  const reservedOutputTokens = Math.min(parsedLimits.maxOutputTokens, Math.floor(contextWindow * 0.25));
  const safetyMargin = Math.ceil(contextWindow * 0.05);
  const usable = Math.max(0, contextWindow - reservedOutputTokens - safetyMargin);

  // Pinned context is protected but capped so it can never starve the tail.
  const pinnedBudget = Math.min(pinnedTokenEstimate, Math.floor(usable * 0.35));
  const remaining = Math.max(0, usable - pinnedBudget);

  const toolSchemaBudget = Math.floor(remaining * 0.2);
  const recentTailBudget = Math.floor(remaining * 0.5);
  const relevantHistoryBudget = Math.max(0, remaining - toolSchemaBudget - recentTailBudget);

  return ContextBudgetPlanSchema.parse({
    contextWindow,
    reservedOutputTokens,
    pinnedBudget,
    recentTailBudget,
    relevantHistoryBudget,
    toolSchemaBudget,
    safetyMargin,
  });
}

/** True when the planned budgets fit inside the window (invariant for tests). */
export function budgetFitsWindow(plan: ContextBudgetPlan): boolean {
  const total =
    plan.reservedOutputTokens +
    plan.safetyMargin +
    plan.pinnedBudget +
    plan.recentTailBudget +
    plan.relevantHistoryBudget +
    plan.toolSchemaBudget;
  return total <= plan.contextWindow;
}

export { estimateTokens };
