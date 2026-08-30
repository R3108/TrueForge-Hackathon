/**
 * Phase 1 — Canonical task contract and deterministic RequestCompiler.
 *
 * The compiler turns a raw user brief into a durable, versioned {@link TaskContract}
 * describing what the harness believes it was asked to accomplish. It runs
 * entirely deterministically (no model call, no tools) so it is cheap, testable,
 * and cannot leak hidden reasoning.
 *
 * Simple conversational questions are detected and bypassed with a lightweight
 * `question` contract so they never incur the heavier action-task machinery.
 *
 * Provenance is first-class: every extracted requirement is tagged with whether
 * it came from the user, was inferred by the harness, imposed by policy, or
 * discovered from a tool. Untrusted repository/tool content is never promoted to
 * a user-authored constraint.
 */

import { z } from 'zod';
import {
  LIMITS,
  boundedArray,
  idString,
  objectiveText,
  pathString,
  policyVersionString,
  shortText,
} from './schema.ts';

export const TaskTypeSchema = z.enum([
  'question',
  'investigation',
  'bug_fix',
  'feature',
  'refactor',
  'operation',
  'unknown',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const ProvenanceSchema = z.enum(['user', 'harness-inferred', 'policy', 'tool-discovered']);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ContractStatusSchema = z.enum(['draft', 'active', 'blocked', 'satisfied', 'cancelled']);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

export const TaskConstraintSchema = z.strictObject({
  id: idString,
  text: shortText,
  provenance: ProvenanceSchema,
});
export type TaskConstraint = z.infer<typeof TaskConstraintSchema>;

export const AcceptanceCriterionSchema = z.strictObject({
  id: idString,
  text: shortText,
  provenance: ProvenanceSchema,
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const EvidenceRequirementKindSchema = z.enum([
  'regression_reproduction',
  'targeted_test_pass',
  'full_suite_pass',
  'human_approval',
  'tool_result',
]);
export type EvidenceRequirementKind = z.infer<typeof EvidenceRequirementKindSchema>;

export const EvidenceRequirementSchema = z.strictObject({
  id: idString,
  kind: EvidenceRequirementKindSchema,
  description: shortText,
  provenance: ProvenanceSchema,
});
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

export const ResourceReferenceSchema = z.strictObject({
  kind: z.enum(['file', 'repository', 'command', 'branch']),
  value: pathString,
  provenance: ProvenanceSchema,
});
export type ResourceReference = z.infer<typeof ResourceReferenceSchema>;

export const TaskAmbiguitySchema = z.strictObject({
  id: idString,
  text: shortText,
  blocking: z.boolean(),
});
export type TaskAmbiguity = z.infer<typeof TaskAmbiguitySchema>;

export const TaskContractSchema = z.strictObject({
  version: z.number().int().min(0),
  taskId: idString,
  objective: objectiveText,
  taskType: TaskTypeSchema,
  constraints: boundedArray(TaskConstraintSchema, LIMITS.smallArray),
  acceptanceCriteria: boundedArray(AcceptanceCriterionSchema, LIMITS.smallArray),
  requiredEvidence: boundedArray(EvidenceRequirementSchema, LIMITS.smallArray),
  referencedResources: boundedArray(ResourceReferenceSchema, LIMITS.smallArray),
  ambiguities: boundedArray(TaskAmbiguitySchema, LIMITS.smallArray),
  risk: z.enum(['low', 'medium', 'high', 'unknown']),
  status: ContractStatusSchema,
  revision: z.number().int().min(1),
  /** True when the request was simple enough to bypass full compilation. */
  bypassed: z.boolean(),
  /** True when the deterministic compiler fell back conservatively. */
  fallback: z.boolean(),
  /**
   * The active policy version captured at compile time. Verification compares
   * this against the live policy version so that a policy advance mid-incident
   * invalidates evidence produced under the prior policy.
   */
  policyVersion: policyVersionString,
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const CONTRACT_SCHEMA_VERSION = 1;

export const CompilerOptionsSchema = z.strictObject({
  /** Bound into policy-provenance constraints/evidence. */
  requireTestEvidence: z.boolean(),
  writePaths: boundedArray(pathString, LIMITS.smallArray).readonly(),
  targetRepo: pathString,
  baseBranch: pathString,
  /** Active policy version at compile time, captured into the contract. */
  policyVersion: policyVersionString,
});
export type CompilerOptions = z.infer<typeof CompilerOptionsSchema>;

const SIMPLE_QUESTION_LEADS =
  /^(what|why|how|when|who|where|which|is|are|does|do|can|could|should|would|explain|describe|tell me)\b/i;
const ACTION_VERBS =
  /\b(fix|patch|repair|reproduce|implement|add|create|write|refactor|rename|migrate|deploy|open a pr|open a pull request|update|delete|remove|change|resolve|debug|investigate)\b/i;
const BUG_SIGNALS =
  /\b(error|exception|stack trace|traceback|crash|fails?|failing|regression|bug|throws?|500|null|undefined)\b/i;
const REFACTOR_SIGNALS = /\brefactor|clean up|restructure|rename|extract\b/i;
const FEATURE_SIGNALS = /\b(add|implement|introduce|build|create)\b/i;
const INVESTIGATE_SIGNALS = /\b(investigate|diagnose|analy[sz]e|root cause)\b/i;
const OPERATION_SIGNALS = /\b(deploy|rollout|migrate|provision|restart|scale)\b/i;

const FILE_REF = /\b([\w./-]+\.[a-z0-9]{1,6})\b/gi;
const COMMAND_HINT = /`([^`]{2,120})`/g;
const REPO_REF = /\b([\w.-]+\/[\w.-]+)\b/g;
const PROHIBITION =
  /\b(do not|don't|never|must not|avoid|without (?:touching|modifying|changing))\b[^.\n]{0,120}/gi;
const OUTPUT_FORMAT =
  /\b(as (?:a )?(?:json|table|markdown|list|bullet points|code block)|in (?:json|markdown|yaml))\b/gi;
const EXPLICIT_CRITERIA =
  /\b(so that|such that|ensure that|it should|must (?:pass|succeed|return)|acceptance criteria:?)\b[^.\n]{0,160}/gi;

let counter = 0;
function localId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
}

/**
 * Decide whether a brief is a simple conversational question. Simple questions
 * skip the action-task pipeline entirely.
 */
export function isSimpleQuestion(brief: string): boolean {
  const trimmed = brief.trim();
  if (trimmed.length === 0) return true;
  const looksLikeQuestion = SIMPLE_QUESTION_LEADS.test(trimmed) || trimmed.endsWith('?');
  const looksLikeAction = ACTION_VERBS.test(trimmed);
  const hasResource = /`/.test(trimmed) || FILE_REF.test(trimmed);
  FILE_REF.lastIndex = 0;
  return looksLikeQuestion && !looksLikeAction && !hasResource && trimmed.length <= 280;
}

function classify(brief: string): TaskType {
  if (isSimpleQuestion(brief)) return 'question';
  if (BUG_SIGNALS.test(brief) && ACTION_VERBS.test(brief)) return 'bug_fix';
  if (REFACTOR_SIGNALS.test(brief)) return 'refactor';
  if (OPERATION_SIGNALS.test(brief)) return 'operation';
  if (INVESTIGATE_SIGNALS.test(brief)) return 'investigation';
  if (FEATURE_SIGNALS.test(brief)) return 'feature';
  if (ACTION_VERBS.test(brief)) return 'operation';
  return 'unknown';
}

function dedupe<T extends { text?: string; value?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = (item.text ?? item.value ?? '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractResources(brief: string, options: CompilerOptions): ResourceReference[] {
  const resources: ResourceReference[] = [];
  for (const match of brief.matchAll(FILE_REF)) {
    const value = match[1];
    if (value) resources.push({ kind: 'file', value, provenance: 'user' });
  }
  for (const match of brief.matchAll(COMMAND_HINT)) {
    const value = match[1]?.trim();
    if (value) resources.push({ kind: 'command', value, provenance: 'user' });
  }
  for (const match of brief.matchAll(REPO_REF)) {
    const value = match[1];
    if (value && !value.includes('.') && value !== options.baseBranch) {
      resources.push({ kind: 'repository', value, provenance: 'user' });
    }
  }
  resources.push({ kind: 'repository', value: options.targetRepo, provenance: 'policy' });
  resources.push({ kind: 'branch', value: options.baseBranch, provenance: 'policy' });
  return dedupe(resources);
}

function extractConstraints(brief: string, options: CompilerOptions): TaskConstraint[] {
  const constraints: TaskConstraint[] = [];
  for (const match of brief.matchAll(PROHIBITION)) {
    const text = match[0]?.trim();
    if (text) constraints.push({ id: localId('con'), text, provenance: 'user' });
  }
  for (const match of brief.matchAll(OUTPUT_FORMAT)) {
    const text = match[0]?.trim();
    if (text) constraints.push({ id: localId('con'), text: `Output format: ${text}`, provenance: 'user' });
  }
  constraints.push({
    id: localId('con'),
    text: `Writes are restricted to ${options.writePaths.join(', ')} in ${options.targetRepo}.`,
    provenance: 'policy',
  });
  constraints.push({
    id: localId('con'),
    text: `Never push directly to protected base branch ${options.baseBranch}.`,
    provenance: 'policy',
  });
  return dedupe(constraints);
}

/**
 * Canonical texts of the harness-inferred acceptance criteria, one per action
 * task type. Exported because TWO modules must agree on them byte-for-byte:
 * this module seeds them into the contract, and the runtime's evidence
 * projection (run.ts) clears them by exact text when their typed evidence
 * arrives. Rewording one side without the other silently stops that criterion
 * from ever clearing - so the texts live here, once, and both sides import.
 */
export const HARNESS_INFERRED_CRITERIA = {
  regressionReproduced: 'The reported failure is reproduced by a failing test.',
  fixTurnsTestGreen: 'The fix turns the failing test green without breaking the suite.',
  featureCovered: 'The new behavior is covered by a passing test.',
  refactorStillGreen: 'Existing tests still pass after the refactor.',
} as const;

function extractCriteria(brief: string, taskType: TaskType): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  for (const match of brief.matchAll(EXPLICIT_CRITERIA)) {
    const text = match[0]?.trim();
    if (text) criteria.push({ id: localId('ac'), text, provenance: 'user' });
  }
  if (taskType === 'bug_fix') {
    criteria.push(
      { id: localId('ac'), text: HARNESS_INFERRED_CRITERIA.regressionReproduced, provenance: 'harness-inferred' },
      { id: localId('ac'), text: HARNESS_INFERRED_CRITERIA.fixTurnsTestGreen, provenance: 'harness-inferred' },
    );
  } else if (taskType === 'feature') {
    criteria.push({ id: localId('ac'), text: HARNESS_INFERRED_CRITERIA.featureCovered, provenance: 'harness-inferred' });
  } else if (taskType === 'refactor') {
    criteria.push({ id: localId('ac'), text: HARNESS_INFERRED_CRITERIA.refactorStillGreen, provenance: 'harness-inferred' });
  }
  return dedupe(criteria);
}

function extractEvidence(taskType: TaskType, options: CompilerOptions): EvidenceRequirement[] {
  const evidence: EvidenceRequirement[] = [];
  const actionTask = taskType !== 'question';
  if (
    actionTask &&
    options.requireTestEvidence &&
    (taskType === 'bug_fix' || taskType === 'feature' || taskType === 'refactor')
  ) {
    if (taskType === 'bug_fix') {
      evidence.push({
        id: localId('ev'),
        kind: 'regression_reproduction',
        description: 'A failing test that reproduces the reported regression.',
        provenance: 'policy',
      });
    }
    evidence.push(
      { id: localId('ev'), kind: 'targeted_test_pass', description: 'Targeted test passes at the current workspace epoch.', provenance: 'policy' },
      { id: localId('ev'), kind: 'full_suite_pass', description: 'Full suite passes at the current workspace epoch.', provenance: 'policy' },
    );
  }
  if (actionTask) {
    evidence.push({
      id: localId('ev'),
      kind: 'human_approval',
      description: 'Human approval before any repository write.',
      provenance: 'policy',
    });
  }
  return evidence;
}

function detectAmbiguities(brief: string, taskType: TaskType): TaskAmbiguity[] {
  const ambiguities: TaskAmbiguity[] = [];
  if (taskType === 'unknown' && brief.trim().length > 0) {
    ambiguities.push({
      id: localId('amb'),
      text: 'The requested action could not be classified from the brief alone.',
      blocking: false,
    });
  }
  if (ACTION_VERBS.test(brief) && /\beither\b|\bversus\b|\bvs\.?\b/i.test(brief)) {
    ambiguities.push({
      id: localId('amb'),
      text: 'The brief presents more than one candidate approach; the correct one is not stated.',
      blocking: true,
    });
  }
  return ambiguities;
}

function riskOf(taskType: TaskType): TaskContract['risk'] {
  switch (taskType) {
    case 'question':
    case 'investigation':
      return 'low';
    case 'refactor':
    case 'feature':
      return 'medium';
    case 'bug_fix':
    case 'operation':
      return 'high';
    default:
      return 'unknown';
  }
}

/**
 * Deterministically compile a brief into a durable contract. Never throws; on
 * internal failure it returns a conservative fallback contract flagged as such.
 */
export function compileTaskContract(
  brief: string,
  options: CompilerOptions,
  taskId: string,
): TaskContract {
  try {
    const objective = brief.trim().split(/\r?\n/, 1)[0]?.slice(0, 500) ?? '';
    const taskType = classify(brief);

    if (taskType === 'question') {
      return TaskContractSchema.parse({
        version: CONTRACT_SCHEMA_VERSION,
        taskId,
        objective,
        taskType,
        constraints: [],
        acceptanceCriteria: [],
        requiredEvidence: [],
        referencedResources: [],
        ambiguities: [],
        risk: 'low',
        status: 'active',
        revision: 1,
        bypassed: true,
        fallback: false,
        policyVersion: options.policyVersion,
      });
    }

    const ambiguities = detectAmbiguities(brief, taskType);
    return TaskContractSchema.parse({
      version: CONTRACT_SCHEMA_VERSION,
      taskId,
      objective,
      taskType,
      constraints: extractConstraints(brief, options),
      acceptanceCriteria: extractCriteria(brief, taskType),
      requiredEvidence: extractEvidence(taskType, options),
      referencedResources: extractResources(brief, options),
      ambiguities,
      risk: riskOf(taskType),
      status: ambiguities.some((a) => a.blocking) ? 'blocked' : 'active',
      revision: 1,
      bypassed: false,
      fallback: false,
      policyVersion: options.policyVersion,
    });
  } catch {
    return TaskContractSchema.parse({
      version: CONTRACT_SCHEMA_VERSION,
      taskId,
      objective: brief.trim().slice(0, 500),
      taskType: 'unknown',
      constraints: [
        {
          id: localId('con'),
          text: `Writes are restricted to ${options.writePaths.join(', ')} in ${options.targetRepo}.`,
          provenance: 'policy',
        },
      ],
      acceptanceCriteria: [],
      requiredEvidence: [
        { id: localId('ev'), kind: 'human_approval', description: 'Human approval before any repository write.', provenance: 'policy' },
      ],
      referencedResources: [],
      ambiguities: [{ id: localId('amb'), text: 'Contract compilation fell back conservatively.', blocking: false }],
      risk: 'unknown',
      status: 'active',
      revision: 1,
      bypassed: false,
      fallback: true,
      policyVersion: options.policyVersion,
    });
  }
}

/**
 * A user correction creates a NEW revision rather than mutating history. The
 * caller is expected to persist both the prior and the returned contract.
 */
export function reviseContract(
  prior: TaskContract,
  correction: string,
  options: CompilerOptions,
): TaskContract {
  const recompiled = compileTaskContract(correction, options, prior.taskId);
  return TaskContractSchema.parse({
    ...recompiled,
    revision: prior.revision + 1,
    constraints: dedupe([
      ...prior.constraints.filter((c) => c.provenance === 'user'),
      ...recompiled.constraints,
    ]),
    acceptanceCriteria: dedupe([
      ...prior.acceptanceCriteria.filter((c) => c.provenance === 'user'),
      ...recompiled.acceptanceCriteria,
    ]),
  });
}

/**
 * Parse an untrusted, externally-persisted contract payload (e.g. rehydrated
 * from durable storage or received across a boundary) into a validated
 * {@link TaskContract}. Throws on malformed input; use at admission/replay.
 */
export function parseTaskContract(value: unknown): TaskContract {
  return TaskContractSchema.parse(value);
}

/** Non-throwing variant returning the Zod result for callers that branch. */
export function safeParseTaskContract(value: unknown): z.ZodSafeParseResult<TaskContract> {
  return TaskContractSchema.safeParse(value);
}
