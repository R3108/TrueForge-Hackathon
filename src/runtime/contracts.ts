export interface ToolInvocationKey {
  sessionId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
}

export interface ValidationViolation {
  code:
    | 'invalid_json'
    | 'missing_required'
    | 'invalid_type'
    | 'unknown_field'
    | 'invalid_path'
    | 'ambiguous_input';
  field?: string;
  message: string;
  repairable: boolean;
}

export interface ToolInvocation {
  key: ToolInvocationKey;
  sourceEventId: string;
  origin: 'agent' | 'sandbox' | 'code-mode' | 'client';
  toolSetId: string;
  toolSetName: string;
  toolType: 'mcp' | 'truefoundry-system' | 'unknown';
  toolName: string;
  arguments: unknown;
  policyVersion: string;
  validationViolations: ValidationViolation[];
}

export type PolicyDecision =
  | { type: 'allow' }
  | { type: 'require_approval'; reasons: string[] }
  | { type: 'repair'; code: string; feedback: string }
  | { type: 'deny'; code: string; reason: string }
  | { type: 'human_review'; reason: string };

export type SideEffectClass =
  | 'read-only'
  | 'workspace-write'
  | 'remote-write'
  | 'destructive'
  | 'unknown';

export type RetryCapability =
  | 'safe'
  | 'native-idempotency'
  | 'reconcile-before-retry'
  | 'never';

export type FailureClass =
  | 'validation'
  | 'policy'
  | 'transport-before-dispatch'
  | 'transport-after-dispatch'
  | 'domain'
  | 'cancelled'
  | 'unknown';

export type AttemptState =
  | 'prepared'
  | 'repair_requested'
  | 'blocked'
  | 'awaiting_approval'
  | 'human_review'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown';

export interface ToolAttemptRecord {
  attemptId: string;
  invocationKey: ToolInvocationKey;
  repairChainId?: string;
  fingerprint: string;
  policyVersion: string;
  sideEffectClass: SideEffectClass;
  retryCapability: RetryCapability;
  state: AttemptState;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalGrant {
  invocationKey: ToolInvocationKey;
  fingerprint: string;
  policyVersion: string;
  status: 'allowed' | 'denied';
  decidedAt: string;
  decidedBy: 'human' | 'managed-policy';
}

export type EvidenceKind =
  | 'regression_failure'
  | 'targeted_test_pass'
  | 'full_suite_pass'
  | 'policy_pass'
  | 'repository_match'
  | 'repair_completed';

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  invocationKey: ToolInvocationKey;
  workspaceEpoch: number;
  commandFingerprint?: string;
  status: 'observed' | 'invalidated';
  observedAt: string;
  outputDigest?: string;
}

export interface PendingApproval {
  kind: 'approval';
  actionId: string;
  invocation: ToolInvocation;
}

export interface PendingResponse {
  kind: 'response';
  actionId: string;
  invocation: ToolInvocation;
}

export type PendingAction = PendingApproval | PendingResponse;

export function sameInvocationKey(a: ToolInvocationKey, b: ToolInvocationKey): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.threadId === b.threadId &&
    a.toolCallId === b.toolCallId
  );
}
