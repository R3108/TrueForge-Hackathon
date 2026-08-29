import { createHash, randomUUID } from 'node:crypto';
import type {
  EvidenceKind,
  EvidenceRecord,
  ToolInvocation,
  ToolInvocationKey,
} from './contracts.ts';

export interface TestEvidencePolicy {
  targetedCommand?: string;
  fullSuiteCommand?: string;
  trustedExecutionTool?: {
    toolSetId: string;
    toolSetName: string;
    toolType: ToolInvocation['toolType'];
  };
}

export interface EvidenceSummary {
  workspaceEpoch: number;
  regressionObserved: boolean;
  regressionIsHistorical: boolean;
  targetedTestPassed: boolean;
  fullSuitePassed: boolean;
  unverifiedSuccessObserved: boolean;
  records: readonly EvidenceRecord[];
}

interface ExecutionFacts {
  exitCode: number;
  timedOut: boolean;
  completed: boolean;
  succeeded: boolean;
}

export interface TrustedExecutionEnvelope {
  executionFacts: {
    version: 1;
    status: 'succeeded' | 'failed';
    exitCode: number;
    timedOut: boolean;
  };
}

const REMOTE_MUTATIONS = new Set([
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

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stringField(args: unknown, field: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function commandOf(invocation: ToolInvocation): string | undefined {
  return (
    stringField(invocation.arguments, 'command') ??
    stringField(invocation.arguments, 'cmd') ??
    stringField(invocation.arguments, 'script')
  );
}

function isSafeExactCommand(actual: string, expected: string | undefined): boolean {
  if (!expected || normalizeCommand(actual) !== normalizeCommand(expected)) return false;
  return !/(?:[&;|`<>\r\n]|\$\()/u.test(actual);
}

function isMutation(invocation: ToolInvocation, configuredTestCommand: boolean): boolean {
  if (REMOTE_MUTATIONS.has(invocation.toolName)) return true;
  if (commandOf(invocation)) return !configuredTestCommand;
  return /(?:write|edit|patch|delete|remove|create|move|rename|replace).*(?:file|workspace)|(?:file|workspace).*(?:write|edit|delete|create)/i.test(
    invocation.toolName,
  );
}

function executionFacts(content: unknown): ExecutionFacts | undefined {
  // SDK 0.1.3 tool responses are opaque strings. They remain unverified even
  // when they happen to contain JSON; only a host-produced, fixed-path envelope
  // can establish execution facts in deterministic fixtures or future adapters.
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const envelope = (content as Record<string, unknown>).executionFacts;
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return undefined;
  const facts = envelope as Record<string, unknown>;
  if (
    facts.version !== 1 ||
    (facts.status !== 'succeeded' && facts.status !== 'failed') ||
    typeof facts.exitCode !== 'number' ||
    !Number.isInteger(facts.exitCode) ||
    typeof facts.timedOut !== 'boolean'
  ) {
    return undefined;
  }
  const succeeded = facts.status === 'succeeded';
  if (facts.timedOut || (succeeded && facts.exitCode !== 0) || (!succeeded && facts.exitCode === 0)) {
    return undefined;
  }
  return {
    exitCode: facts.exitCode,
    timedOut: facts.timedOut,
    completed: true,
    succeeded,
  };
}

function keyOf(key: ToolInvocationKey): string {
  return `${key.sessionId}\u0000${key.turnId}\u0000${key.threadId}\u0000${key.toolCallId}`;
}

export class EvidenceLedger {
  readonly #policy: TestEvidencePolicy;
  readonly #invocations = new Map<string, ToolInvocation>();
  readonly #records: EvidenceRecord[] = [];
  #workspaceEpoch = 0;
  #unverifiedSuccessObserved = false;

  constructor(policy: TestEvidencePolicy = {}) {
    this.#policy = policy;
  }

  get workspaceEpoch(): number {
    return this.#workspaceEpoch;
  }

  observeInvocation(invocation: ToolInvocation): void {
    this.#invocations.set(keyOf(invocation.key), invocation);
  }

  observeResponse(key: ToolInvocationKey, content: unknown): void {
    const invocation = this.#invocations.get(keyOf(key));
    if (!invocation) return;
    this.#recordResponse(invocation, content);
  }

  observeResponseForCall(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    content: unknown,
  ): void {
    const matches = [...this.#invocations.values()].filter(
      (candidate) =>
        candidate.key.sessionId === sessionId &&
        candidate.key.threadId === threadId &&
        candidate.key.toolCallId === toolCallId,
    );
    if (matches.length === 1 && matches[0]) this.#recordResponse(matches[0], content);
  }

  #recordResponse(invocation: ToolInvocation, content: unknown): void {
    const trusted = this.#policy.trustedExecutionTool;
    const trustedProducer =
      invocation.origin === 'sandbox' &&
      trusted !== undefined &&
      invocation.toolSetId === trusted.toolSetId &&
      invocation.toolSetName === trusted.toolSetName &&
      invocation.toolType === trusted.toolType;
    const facts = trustedProducer ? executionFacts(content) : undefined;
    const command = commandOf(invocation);
    const configuredTestCommand =
      command !== undefined &&
      (isSafeExactCommand(command, this.#policy.targetedCommand) ||
        isSafeExactCommand(command, this.#policy.fullSuiteCommand));
    if (command && configuredTestCommand) {
      this.#observeTest(invocation, command, facts, content);
    } else if (command && /pass|success|green/i.test(String(content))) {
      this.#unverifiedSuccessObserved = true;
    }

    if (isMutation(invocation, configuredTestCommand)) {
      // Unknown shell/workspace execution is conservatively a mutation even
      // when the opaque response cannot prove success or failure.
      this.incrementWorkspaceEpoch();
    }
  }

  incrementWorkspaceEpoch(): void {
    this.#workspaceEpoch++;
    for (const evidence of this.#records) {
      if (evidence.status === 'observed' && evidence.workspaceEpoch !== this.#workspaceEpoch) {
        evidence.status = 'invalidated';
      }
    }
  }

  addPolicyEvidence(kind: 'policy_pass' | 'repository_match', invocation: ToolInvocation): void {
    this.#add(kind, invocation);
  }

  addRepairCompleted(invocation: ToolInvocation): void {
    this.#add('repair_completed', invocation);
  }

  summary(): EvidenceSummary {
    const current = (kind: EvidenceKind): boolean =>
      this.#records.some(
        (record) =>
          record.kind === kind &&
          record.status === 'observed' &&
          record.workspaceEpoch === this.#workspaceEpoch,
      );
    const anyRegression = this.#records.some((record) => record.kind === 'regression_failure');

    return {
      workspaceEpoch: this.#workspaceEpoch,
      regressionObserved: anyRegression,
      regressionIsHistorical: anyRegression && !current('regression_failure'),
      targetedTestPassed: current('targeted_test_pass'),
      fullSuitePassed: current('full_suite_pass'),
      unverifiedSuccessObserved: this.#unverifiedSuccessObserved,
      records: this.#records,
    };
  }

  #observeTest(
    invocation: ToolInvocation,
    command: string,
    facts: ExecutionFacts | undefined,
    content: unknown,
  ): void {
    const normalized = normalizeCommand(command);
    if (!facts || !facts.completed || facts.timedOut) {
      const rendered = typeof content === 'string' ? content : JSON.stringify(content);
      if (/pass|success|green/i.test(rendered)) this.#unverifiedSuccessObserved = true;
      return;
    }

    if (!facts.succeeded) {
      this.#add('regression_failure', invocation, normalized, content);
      return;
    }

    const targeted = isSafeExactCommand(command, this.#policy.targetedCommand);
    const full = isSafeExactCommand(command, this.#policy.fullSuiteCommand);

    if (targeted) this.#add('targeted_test_pass', invocation, normalized, content);
    if (full) this.#add('full_suite_pass', invocation, normalized, content);
  }

  #add(
    kind: EvidenceKind,
    invocation: ToolInvocation,
    command?: string,
    output?: unknown,
  ): void {
    this.#records.push({
      id: randomUUID(),
      kind,
      invocationKey: invocation.key,
      workspaceEpoch: this.#workspaceEpoch,
      commandFingerprint: command ? digest(command) : undefined,
      status: 'observed',
      observedAt: new Date().toISOString(),
      outputDigest: output === undefined ? undefined : digest(String(output)),
    });
  }
}
