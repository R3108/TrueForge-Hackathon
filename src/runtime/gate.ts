import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  ApprovalGrant,
  AttemptState,
  PolicyDecision,
  RetryCapability,
  SideEffectClass,
  ToolAttemptRecord,
  ToolInvocation,
} from './contracts.ts';
import { normalizePath, isInsidePerimeter } from './perimeter.ts';
import type { EvidenceLedger, EvidenceSummary } from './evidence.ts';

export interface FirewallPolicy {
  targetRepo: string;
  baseBranch: string;
  writePaths: string[];
  githubConnector: string;
  githubConnectorId: string;
  policyVersion: string;
  requireTestEvidence: boolean;
}

export interface GateEvaluation {
  decision: PolicyDecision;
  fingerprint: string;
  attempt: ToolAttemptRecord;
  repairAttempt: number;
  evidence: EvidenceSummary;
}

interface RepairChain {
  id: string;
  threadId: string;
  family: string;
  attempts: number;
  lastCallId: string;
  repairTurnId: string;
  occurrences: Map<string, number>;
  terminal: boolean;
}

interface RecordedDecision {
  fingerprint: string;
  status: 'allow' | 'deny';
  reason?: string;
}

const WRITE_TOOLS = new Set([
  'create_branch',
  'create_or_update_file',
  'push_files',
  'delete_file',
  'create_pull_request',
  'update_pull_request',
  'merge_pull_request',
  'create_issue',
  'update_issue',
  'add_issue_comment',
]);

const DESTRUCTIVE_TOOLS = new Set(['delete_file', 'merge_pull_request']);
const PATH_TOOLS = new Set(['create_or_update_file', 'push_files', 'delete_file']);
const DIRECT_BRANCH_WRITES = new Set(['create_or_update_file', 'push_files', 'delete_file']);
const REQUIRED_FIELDS: Record<string, string[]> = {
  create_branch: ['owner', 'repo', 'branch'],
  create_or_update_file: ['owner', 'repo', 'path', 'branch', 'content'],
  push_files: ['owner', 'repo', 'branch', 'files'],
  delete_file: ['owner', 'repo', 'path', 'branch'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  update_pull_request: ['owner', 'repo'],
  merge_pull_request: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  update_issue: ['owner', 'repo'],
  add_issue_comment: ['owner', 'repo', 'body'],
};

const TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  prepared: ['repair_requested', 'blocked', 'awaiting_approval', 'human_review', 'approved'],
  repair_requested: ['blocked'],
  blocked: [],
  awaiting_approval: ['approved', 'blocked'],
  human_review: ['approved', 'blocked'],
  approved: ['executing', 'blocked'],
  executing: ['succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: ['repair_requested', 'blocked'],
  // Reconciliation may prove that an unknown operation succeeded; otherwise a
  // human must block it. It can never be moved back toward dispatch blindly.
  unknown: ['succeeded', 'blocked'],
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function invocationKeyIdentity(key: ToolInvocation['key']): string {
  return `${key.sessionId}\u0000${key.turnId}\u0000${key.threadId}\u0000${key.toolCallId}`;
}

function invocationIdentity(invocation: ToolInvocation): string {
  return invocationKeyIdentity(invocation.key);
}

function operationFamily(invocation: ToolInvocation): string {
  return `${invocation.key.sessionId}\u0000${invocation.key.threadId}\u0000${invocation.toolName}`;
}

function repositoryOf(args: Record<string, unknown>): string | undefined {
  const owner = stringValue(args.owner);
  const repo = stringValue(args.repo);
  if (owner && repo) return `${owner}/${repo}`.toLowerCase();
  return stringValue(args.repository)?.toLowerCase();
}

function pathsOf(args: Record<string, unknown>): string[] {
  const result: string[] = [];
  const path = stringValue(args.path);
  if (path) result.push(path);
  if (Array.isArray(args.files)) {
    for (const value of args.files) {
      const file = object(value);
      const filePath = file && stringValue(file.path);
      if (filePath) result.push(filePath);
    }
  }
  return result;
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(path);
}

function secretPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.split('/').at(-1)?.toLowerCase() ?? '';
  return (
    /(^|\/)(?:\.env(?:\.|$)|\.ssh(?:\/|$)|.*(?:secret|credential|token|password).*)/i.test(
      normalized,
    ) ||
    /^(?:\.npmrc|\.pypirc|\.netrc|id_rsa|id_dsa|service-account\.json)$/i.test(base) ||
    /\.(?:pem|key|p12|pfx)$/i.test(base)
  );
}

function schemaViolation(
  toolName: string,
  args: Record<string, unknown>,
): { field: string; instruction: string } | undefined {
  if (toolName === 'push_files') {
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0) {
      return { field: 'files', instruction: 'Submit a non-empty files array.' };
    }
    for (const [index, value] of files.entries()) {
      const file = object(value);
      if (!file || !stringValue(file.path) || typeof file.content !== 'string') {
        return {
          field: `files[${index}]`,
          instruction: 'Every file must be an object with a repository-relative path and string content.',
        };
      }
    }
  }

  const targetFields: Partial<Record<string, string[]>> = {
    update_pull_request: ['pullNumber', 'pull_number'],
    merge_pull_request: ['pullNumber', 'pull_number'],
    update_issue: ['issueNumber', 'issue_number'],
    add_issue_comment: ['issueNumber', 'issue_number'],
  };
  const alternatives = targetFields[toolName];
  if (alternatives && !alternatives.some((field) => typeof args[field] === 'number')) {
    return {
      field: alternatives.join('|'),
      instruction: `Submit a numeric ${alternatives.join(' or ')} target identifier.`,
    };
  }
  return undefined;
}

function classify(toolName: string): {
  sideEffectClass: SideEffectClass;
  retryCapability: RetryCapability;
} {
  if (DESTRUCTIVE_TOOLS.has(toolName)) {
    return { sideEffectClass: 'destructive', retryCapability: 'never' };
  }
  if (toolName === 'create_pull_request') {
    return { sideEffectClass: 'remote-write', retryCapability: 'reconcile-before-retry' };
  }
  if (WRITE_TOOLS.has(toolName)) {
    return { sideEffectClass: 'remote-write', retryCapability: 'reconcile-before-retry' };
  }
  return { sideEffectClass: 'unknown', retryCapability: 'never' };
}

function repairFeedback(code: string, field: string | undefined, instruction: string): string {
  return JSON.stringify({
    error: 'tool_call_rejected',
    repairable: true,
    code,
    ...(field ? { field } : {}),
    instruction,
  });
}

export class ToolCallGate {
  readonly #policy: FirewallPolicy;
  readonly #evidence: EvidenceLedger;
  readonly #hmacKey: Buffer;
  readonly #attempts: ToolAttemptRecord[] = [];
  readonly #repairByThread = new Map<string, RepairChain>();
  readonly #deniedFamilies = new Set<string>();
  readonly #processed = new Map<string, RecordedDecision>();
  readonly #grants: ApprovalGrant[] = [];

  constructor(policy: FirewallPolicy, evidence: EvidenceLedger, hmacKey = randomBytes(32)) {
    this.#policy = policy;
    this.#evidence = evidence;
    this.#hmacKey = hmacKey;
  }

  get attempts(): readonly ToolAttemptRecord[] {
    return this.#attempts;
  }

  get grants(): readonly ApprovalGrant[] {
    return this.#grants;
  }

  fingerprint(invocation: ToolInvocation): string {
    const args = object(invocation.arguments) ?? invocation.arguments;
    const target = object(invocation.arguments);
    const repository = target ? repositoryOf(target) : undefined;
    const branch = target && stringValue(target.branch ?? target.head ?? target.base);
    const material = canonical({
      toolSetId: invocation.toolSetId,
      toolSetName: invocation.toolSetName,
      toolType: invocation.toolType,
      toolName: invocation.toolName,
      arguments: args,
      repository,
      branch,
      invocationPolicyVersion: invocation.policyVersion,
      activePolicyVersion: this.#policy.policyVersion,
    });
    return createHmac('sha256', this.#hmacKey).update(material).digest('hex');
  }

  isConfiguredWrite(invocation: ToolInvocation): boolean {
    return (
      invocation.toolType === 'mcp' &&
      invocation.toolSetName === this.#policy.githubConnector &&
      invocation.toolSetId === this.#policy.githubConnectorId &&
      WRITE_TOOLS.has(invocation.toolName)
    );
  }

  processedDecision(invocation: ToolInvocation): RecordedDecision | undefined {
    const recorded = this.#processed.get(invocationIdentity(invocation));
    if (recorded) {
      if (recorded.fingerprint !== this.fingerprint(invocation)) {
        return {
          fingerprint: recorded.fingerprint,
          status: 'deny',
          reason: 'Approval identity changed for an already processed tool-call ID.',
        };
      }
      return recorded;
    }
    if (this.#deniedFamilies.has(operationFamily(invocation))) {
      return {
        fingerprint: this.fingerprint(invocation),
        status: 'deny',
        reason: 'A human denial is terminal for this tool family in the active incident thread.',
      };
    }
    return undefined;
  }

  evaluate(invocation: ToolInvocation): GateEvaluation {
    const fingerprint = this.fingerprint(invocation);
    const now = new Date().toISOString();
    const classification = classify(invocation.toolName);
    const attempt: ToolAttemptRecord = {
      attemptId: randomUUID(),
      invocationKey: invocation.key,
      fingerprint,
      policyVersion: this.#policy.policyVersion,
      ...classification,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    this.#attempts.push(attempt);

    const decision = this.#policyDecision(invocation, fingerprint, attempt);
    const repairAttempt = this.#repairByThread.get(invocation.key.threadId)?.attempts ?? 0;
    if (decision.type === 'repair') this.transition(attempt, 'repair_requested');
    else if (decision.type === 'deny') this.transition(attempt, 'blocked');
    else if (decision.type === 'allow') this.transition(attempt, 'approved');
    else if (decision.type === 'human_review') this.transition(attempt, 'human_review');
    else this.transition(attempt, 'awaiting_approval');

    return { decision, fingerprint, attempt, repairAttempt, evidence: this.#evidence.summary() };
  }

  recordHumanDecision(
    invocation: ToolInvocation,
    fingerprint: string,
    status: 'allow' | 'deny',
    reason?: string,
  ): void {
    const identity = invocationIdentity(invocation);
    const expected = this.fingerprint(invocation);
    const safeStatus = fingerprint === expected ? status : 'deny';
    const safeReason =
      fingerprint === expected ? reason : 'Approval fingerprint no longer matches the invocation.';
    this.#processed.set(identity, { fingerprint: expected, status: safeStatus, reason: safeReason });
    this.#grants.push({
      invocationKey: invocation.key,
      fingerprint: expected,
      policyVersion: this.#policy.policyVersion,
      status: safeStatus === 'allow' ? 'allowed' : 'denied',
      decidedAt: new Date().toISOString(),
      decidedBy: 'human',
    });
    const attempt = this.#latestAttempt(identity, fingerprint);
    if (
      attempt &&
      (attempt.state === 'awaiting_approval' || attempt.state === 'human_review')
    ) {
      this.transition(attempt, safeStatus === 'allow' ? 'approved' : 'blocked');
    }
    const chain = this.#repairByThread.get(invocation.key.threadId);
    if (safeStatus === 'deny') {
      this.#deniedFamilies.add(operationFamily(invocation));
      if (chain) chain.terminal = true;
    } else if (chain?.family === invocation.toolName) {
      this.#repairByThread.delete(invocation.key.threadId);
    }
  }

  recordManagedDenial(invocation: ToolInvocation, fingerprint: string, reason: string): void {
    this.#processed.set(invocationIdentity(invocation), { fingerprint, status: 'deny', reason });
    const attempt = this.#latestAttempt(invocationIdentity(invocation), fingerprint);
    if (attempt?.state === 'repair_requested') this.transition(attempt, 'blocked');
    else if (attempt?.state === 'awaiting_approval' || attempt?.state === 'human_review') {
      this.transition(attempt, 'blocked');
    }
  }

  #latestAttempt(identity: string, fingerprint: string): ToolAttemptRecord | undefined {
    return this.#attempts.findLast(
      (attempt) =>
        invocationKeyIdentity(attempt.invocationKey) === identity &&
        attempt.fingerprint === fingerprint,
    );
  }

  transition(attempt: ToolAttemptRecord, next: AttemptState): void {
    if (!TRANSITIONS[attempt.state].includes(next)) {
      throw new Error(`Invalid tool-attempt transition ${attempt.state} -> ${next}.`);
    }
    attempt.state = next;
    attempt.updatedAt = new Date().toISOString();
  }

  #policyDecision(
    invocation: ToolInvocation,
    fingerprint: string,
    attempt: ToolAttemptRecord,
  ): PolicyDecision {
    const priorSameSemantics = this.#attempts.find(
      (candidate) =>
        candidate !== attempt &&
        candidate.invocationKey.sessionId === invocation.key.sessionId &&
        candidate.invocationKey.threadId === invocation.key.threadId &&
        candidate.fingerprint === fingerprint &&
        ['awaiting_approval', 'human_review', 'approved', 'executing', 'succeeded', 'unknown'].includes(
          candidate.state,
        ),
    );
    if (priorSameSemantics) {
      return {
        type: 'deny',
        code: 'repeated_no_progress',
        reason:
          'An equivalent sensitive call is already pending or was previously approved; it cannot be replayed under a fresh call ID.',
      };
    }

    if (invocation.policyVersion !== this.#policy.policyVersion) {
      return {
        type: 'deny',
        code: 'policy_version_mismatch',
        reason: `Invocation policy ${invocation.policyVersion} does not match active policy ${this.#policy.policyVersion}.`,
      };
    }

    if (this.#deniedFamilies.has(operationFamily(invocation))) {
      return {
        type: 'deny',
        code: 'human_denial_terminal',
        reason: 'A human denial is terminal for this tool family in the active incident thread.',
      };
    }

    if (
      invocation.toolType !== 'mcp' ||
      invocation.toolSetName !== this.#policy.githubConnector ||
      invocation.toolSetId !== this.#policy.githubConnectorId
    ) {
      return {
        type: 'deny',
        code: 'untrusted_tool_origin',
        reason: `Tool origin ${invocation.toolSetName}/${invocation.toolSetId} is not the configured GitHub connector.`,
      };
    }

    if (!WRITE_TOOLS.has(invocation.toolName)) {
      return {
        type: 'deny',
        code: 'unknown_sensitive_tool',
        reason: `Unknown approval-gated tool ${invocation.toolName}; failing closed.`,
      };
    }

    const violation = invocation.validationViolations[0];
    if (violation) {
      return this.#requestRepair(invocation, fingerprint, attempt, violation.code, violation.field, violation.message);
    }

    const args = object(invocation.arguments);
    if (!args) {
      return this.#requestRepair(
        invocation,
        fingerprint,
        attempt,
        'invalid_type',
        'arguments',
        'Submit a new call whose arguments are a JSON object.',
      );
    }

    for (const field of REQUIRED_FIELDS[invocation.toolName] ?? []) {
      const value = args[field];
      const present =
        field === 'files'
          ? Array.isArray(value) && value.length > 0
          : typeof value === 'string' && value.trim().length > 0;
      if (!present) {
        return this.#requestRepair(
          invocation,
          fingerprint,
          attempt,
          'missing_required',
          field,
          `Submit a new call with the required ${field} field.`,
        );
      }
    }

    const semanticViolation = schemaViolation(invocation.toolName, args);
    if (semanticViolation) {
      return this.#requestRepair(
        invocation,
        fingerprint,
        attempt,
        'invalid_type',
        semanticViolation.field,
        semanticViolation.instruction,
      );
    }

    const repository = repositoryOf(args);
    if (repository !== this.#policy.targetRepo.toLowerCase()) {
      return {
        type: 'deny',
        code: 'repository_mismatch',
        reason: `Repository ${repository ?? '(missing)'} does not match ${this.#policy.targetRepo}.`,
      };
    }
    const paths = pathsOf(args);
    if (PATH_TOOLS.has(invocation.toolName) && paths.length === 0) {
      return this.#requestRepair(
        invocation,
        fingerprint,
        attempt,
        'missing_required',
        'path',
        'Submit a new call with every repository-relative write path.',
      );
    }
    for (const path of paths) {
      if (isAbsolutePath(path) || !normalizePath(path)) {
        return {
          type: 'deny',
          code: 'invalid_path',
          reason: `Path ${path} is not an unambiguous repository-relative path.`,
        };
      }
      if (secretPath(path)) {
        return {
          type: 'deny',
          code: 'secret_path',
          reason: `Path ${path} is credential-sensitive and cannot be approved.`,
        };
      }
      if (
        this.#policy.writePaths.length === 0 ||
        !isInsidePerimeter(path, this.#policy.writePaths)
      ) {
        return {
          type: 'deny',
          code: 'outside_write_perimeter',
          reason: `Path ${path} is outside the declared write perimeter.`,
        };
      }
    }

    const branch = stringValue(args.branch);
    if (DIRECT_BRANCH_WRITES.has(invocation.toolName) && branch === this.#policy.baseBranch) {
      return {
        type: 'deny',
        code: 'protected_branch',
        reason: `Direct writes to protected base branch ${this.#policy.baseBranch} are forbidden.`,
      };
    }
    if (invocation.toolName === 'create_branch' && branch === this.#policy.baseBranch) {
      return {
        type: 'deny',
        code: 'protected_branch',
        reason: `The new branch cannot be the protected base branch ${this.#policy.baseBranch}.`,
      };
    }
    if (invocation.toolName === 'create_pull_request') {
      const base = stringValue(args.base);
      const head = stringValue(args.head);
      if (base !== this.#policy.baseBranch || head === this.#policy.baseBranch) {
        return {
          type: 'deny',
          code: 'protected_branch',
          reason: `Pull requests must target ${this.#policy.baseBranch} from a different head branch.`,
        };
      }
    }

    if (DESTRUCTIVE_TOOLS.has(invocation.toolName)) {
      return {
        type: 'deny',
        code: 'destructive_operation',
        reason: `${invocation.toolName} is outside the automatic repair perimeter and cannot run.`,
      };
    }

    const chain = this.#repairByThread.get(invocation.key.threadId);
    if (chain && chain.family !== invocation.toolName && !chain.terminal) {
      return {
        type: 'deny',
        code: 'active_repair_conflict',
        reason: 'Another automatic repair chain is active on this thread; human restart is required.',
      };
    }
    if (chain && chain.family === invocation.toolName) {
      if (chain.terminal) {
        return {
          type: 'deny',
          code: 'repair_chain_terminal',
          reason: 'This repair chain is terminal and cannot be reopened by a new call ID.',
        };
      }
      if (chain.repairTurnId === invocation.key.turnId) {
        return {
          type: 'deny',
          code: 'repair_not_continuation',
          reason: 'A sibling call from the same turn cannot satisfy repair feedback.',
        };
      }
      if (chain.lastCallId === invocation.key.toolCallId) {
        return {
          type: 'deny',
          code: 'new_call_required',
          reason: 'A repaired invocation must have a new tool-call ID.',
        };
      }
      attempt.repairChainId = chain.id;
      this.#evidence.addRepairCompleted(invocation);
    }

    this.#evidence.addPolicyEvidence('repository_match', invocation);
    this.#evidence.addPolicyEvidence('policy_pass', invocation);

    if (invocation.toolName === 'create_pull_request' && this.#policy.requireTestEvidence) {
      const evidence = this.#evidence.summary();
      const missing = [
        !evidence.regressionObserved && 'regression reproduction',
        !evidence.targetedTestPassed && 'fresh targeted-test pass',
        !evidence.fullSuitePassed && 'fresh full-suite pass',
      ].filter(Boolean);
      if (missing.length > 0) {
        return {
          type: 'human_review',
          reason: `Test evidence is incomplete: ${missing.join(', ')}.`,
        };
      }
    }

    return {
      type: 'require_approval',
      reasons: [
        'Core TrueForge approval remains required.',
        ...(chain && chain.family === invocation.toolName
          ? [`Corrected call uses fresh ID; repair attempt ${chain.attempts}/2.`]
          : []),
      ],
    };
  }

  #requestRepair(
    invocation: ToolInvocation,
    fingerprint: string,
    attempt: ToolAttemptRecord,
    code: string,
    field: string | undefined,
    instruction: string,
  ): PolicyDecision {
    const threadId = invocation.key.threadId;
    let chain = this.#repairByThread.get(threadId);
    if (chain && (chain.family !== invocation.toolName || chain.terminal)) {
      return {
        type: 'deny',
        code: chain.terminal ? 'repair_chain_terminal' : 'active_repair_conflict',
        reason: chain.terminal
          ? 'This repair chain is terminal and cannot be reopened.'
          : 'A different repair chain is already active on this thread.',
      };
    }
    if (!chain) {
      chain = {
        id: randomUUID(),
        threadId,
        family: invocation.toolName,
        attempts: 0,
        lastCallId: '',
        repairTurnId: invocation.key.turnId,
        occurrences: new Map(),
        terminal: false,
      };
      this.#repairByThread.set(threadId, chain);
    }

    const occurrences = (chain.occurrences.get(fingerprint) ?? 0) + 1;
    chain.occurrences.set(fingerprint, occurrences);
    if (chain.attempts >= 2 || occurrences >= 2) {
      chain.terminal = true;
      return {
        type: 'deny',
        code: occurrences >= 2 ? 'repeated_fingerprint' : 'repair_budget_exhausted',
        reason: 'Automatic repair stopped: the call repeated or exhausted the two-attempt budget.',
      };
    }

    chain.attempts++;
    chain.lastCallId = invocation.key.toolCallId;
    chain.repairTurnId = invocation.key.turnId;
    attempt.repairChainId = chain.id;
    return { type: 'repair', code, feedback: repairFeedback(code, field, instruction) };
  }
}
