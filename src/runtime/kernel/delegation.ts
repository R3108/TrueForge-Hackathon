/**
 * Phase 8 — Typed least-privilege subagent delegation.
 *
 * A {@link DelegationContract} is derived by INTERSECTING parent permissions,
 * the subagent profile, and delegation-specific restrictions. A child can never
 * widen parent authority, never exceed the depth ceiling, and never own a write
 * resource the parent (or a sibling) already owns unless explicitly allowed.
 *
 * Child results are typed {@link ChildResult}s, never prose-only summaries.
 */

import { z } from 'zod';
import { LIMITS, boundedArray, boundedInt, idString, isoDateTime, shortText, text } from './schema.ts';

export const OutputRequirementSchema = z.strictObject({
  id: idString,
  description: shortText,
});
export type OutputRequirement = z.infer<typeof OutputRequirementSchema>;

const capabilityArray = boundedArray(shortText, LIMITS.smallArray);
const resourceArray = boundedArray(shortText, LIMITS.smallArray);

export const DelegationRequestSchema = z.strictObject({
  objective: shortText,
  constraints: boundedArray(shortText, LIMITS.smallArray),
  expectedOutput: boundedArray(OutputRequirementSchema, LIMITS.smallArray),
  /** Capabilities the delegation would like the child to have. */
  requestedToolCapabilities: capabilityArray,
  /** Capabilities the delegation explicitly denies regardless of parent. */
  deniedToolCapabilities: capabilityArray,
  /** Write resources the child wants to own. */
  resourceOwnership: resourceArray,
  evidenceRequirements: boundedArray(shortText, LIMITS.smallArray),
  deadline: isoDateTime.optional(),
  maxSteps: boundedInt(),
});
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

export const ParentAuthoritySchema = z.strictObject({
  parentTaskId: idString,
  /** Capabilities the parent actually holds. The intersection floor. */
  allowedToolCapabilities: capabilityArray,
  /** Write resources already owned by the parent or live siblings. */
  ownedResources: resourceArray,
  /** Current delegation depth of the parent (root = 0). */
  depth: boundedInt(),
  maxDepth: boundedInt(),
  /** Capabilities the subagent profile permits. */
  profileToolCapabilities: capabilityArray,
});
export type ParentAuthority = z.infer<typeof ParentAuthoritySchema>;

export const DelegationContractSchema = z.strictObject({
  parentTaskId: idString,
  delegationId: idString,
  objective: shortText,
  constraints: boundedArray(shortText, LIMITS.smallArray),
  expectedOutput: boundedArray(OutputRequirementSchema, LIMITS.smallArray),
  allowedToolCapabilities: capabilityArray,
  deniedToolCapabilities: capabilityArray,
  resourceOwnership: resourceArray,
  evidenceRequirements: boundedArray(shortText, LIMITS.smallArray),
  deadline: isoDateTime.optional(),
  maxSteps: boundedInt(),
  maxDepth: boundedInt(),
  depth: boundedInt(),
});
export type DelegationContract = z.infer<typeof DelegationContractSchema>;

export const DelegationDenialCodeSchema = z.enum([
  'depth_exceeded',
  'permission_widening',
  'resource_conflict',
  'empty_capability_set',
]);
export type DelegationDenialCode = z.infer<typeof DelegationDenialCodeSchema>;

export type DelegationOutcome =
  | { ok: true; contract: DelegationContract }
  | { ok: false; code: DelegationDenialCode; reason: string };

let delegationSeq = 0;
function nextDelegationId(): string {
  delegationSeq += 1;
  return `deleg-${delegationSeq.toString(36)}`;
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

/**
 * Derive a least-privilege contract. Fails closed on depth violations,
 * permission widening, empty capability sets, and unauthorized resource overlap.
 */
export function deriveDelegation(
  parentAuthority: ParentAuthority,
  delegationRequest: DelegationRequest,
  opts: { allowSharedResources?: boolean } = {},
): DelegationOutcome {
  const parent = ParentAuthoritySchema.parse(parentAuthority);
  const request = DelegationRequestSchema.parse(delegationRequest);
  const childDepth = parent.depth + 1;
  if (childDepth > parent.maxDepth) {
    return { ok: false, code: 'depth_exceeded', reason: `Delegation depth ${childDepth} exceeds max ${parent.maxDepth}.` };
  }

  // Intersection: request ∩ parent ∩ profile, then remove explicit denials.
  const denied = new Set(request.deniedToolCapabilities);
  const allowed = intersect(
    intersect(request.requestedToolCapabilities, parent.allowedToolCapabilities),
    parent.profileToolCapabilities,
  ).filter((cap) => !denied.has(cap));

  // Any requested capability the parent does not hold is a widening attempt.
  const widening = request.requestedToolCapabilities.filter(
    (cap) => !parent.allowedToolCapabilities.includes(cap),
  );
  if (widening.length > 0) {
    return {
      ok: false,
      code: 'permission_widening',
      reason: `Requested capabilities exceed parent authority: ${widening.join(', ')}.`,
    };
  }

  if (allowed.length === 0 && request.requestedToolCapabilities.length > 0) {
    return {
      ok: false,
      code: 'empty_capability_set',
      reason: 'No capability survived the parent/profile/denial intersection.',
    };
  }

  if (!opts.allowSharedResources) {
    const conflict = request.resourceOwnership.filter((r) => parent.ownedResources.includes(r));
    if (conflict.length > 0) {
      return {
        ok: false,
        code: 'resource_conflict',
        reason: `Resources already owned by parent/sibling: ${conflict.join(', ')}.`,
      };
    }
  }

  return {
    ok: true,
    contract: DelegationContractSchema.parse({
      parentTaskId: parent.parentTaskId,
      delegationId: nextDelegationId(),
      objective: request.objective,
      constraints: request.constraints,
      expectedOutput: request.expectedOutput,
      allowedToolCapabilities: allowed,
      deniedToolCapabilities: [...request.deniedToolCapabilities],
      resourceOwnership: [...request.resourceOwnership],
      evidenceRequirements: request.evidenceRequirements,
      ...(request.deadline ? { deadline: request.deadline } : {}),
      maxSteps: request.maxSteps,
      maxDepth: parent.maxDepth,
      depth: childDepth,
    }),
  };
}

export const ChildResultSchema = z.strictObject({
  delegationId: idString,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  resultSummary: text,
  claims: boundedArray(shortText, LIMITS.smallArray),
  evidenceReferences: boundedArray(shortText, LIMITS.smallArray),
  resourcesInspected: boundedArray(shortText, LIMITS.smallArray),
  resourcesChanged: boundedArray(shortText, LIMITS.smallArray),
  unresolvedQuestions: boundedArray(shortText, LIMITS.smallArray),
  recommendedNextAction: shortText,
});
export type ChildResult = z.infer<typeof ChildResultSchema>;

/**
 * Validate a child result against its contract. A child may only report changes
 * to resources it owned; anything else is a structured failure, not accepted
 * prose. The result payload is parsed at this delegation boundary before use.
 */
export function validateChildResult(
  contract: DelegationContract,
  childResult: ChildResult,
): { ok: true } | { ok: false; reason: string } {
  const result = ChildResultSchema.parse(childResult);
  if (result.delegationId !== contract.delegationId) {
    return { ok: false, reason: 'Child result delegation id does not match its contract.' };
  }
  const owned = new Set(contract.resourceOwnership);
  const escaped = result.resourcesChanged.filter((r) => !owned.has(r));
  if (escaped.length > 0) {
    return { ok: false, reason: `Child changed resources it does not own: ${escaped.join(', ')}.` };
  }
  return { ok: true };
}
