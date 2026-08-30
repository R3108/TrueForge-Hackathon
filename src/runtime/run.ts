import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { style, preview, summarizeInline } from './render.ts';
import { requestClearance, requestResponses } from './approvals.ts';
import { EvidenceLedger, type EvidenceSummary, type TestEvidencePolicy } from './evidence.ts';
import { ToolCallGate, type FirewallPolicy } from './gate.ts';
import type { SecretPolicy } from './secrets.ts';
import type { Journal } from './journal.ts';
import type { PendingAction, ToolInvocation } from './contracts.ts';
import {
  requiredActionIdentity,
  resolveRequiredAction,
  threadIdOf,
  toolCallsOf,
  type StreamEvent,
} from './protocol.ts';
import { AdaptiveAgentKernel, type KernelMetrics } from './kernel/index.ts';
import type { ModelLimits } from './kernel/context.ts';
import type { TaskContract } from './kernel/contract.ts';
import { HARNESS_INFERRED_CRITERIA } from './kernel/contract.ts';
import {
  renderBlock,
  renderTaskObjective,
  renderPhaseAndPlan,
  renderContextPlan,
  renderVerification,
  type InfoBlock,
} from './kernel-render.ts';

type TurnInput = TrueForgeApi.TurnInputItem;
const MAX_TURNS = 12;

/** Optional adaptive-kernel configuration. Absent = legacy behavior. */
export interface KernelPolicy {
  enabled: boolean;
  modelLimits: ModelLimits;
}

/**
 * Sink for additive, informational kernel state (task/phase/plan/context/
 * verification/delegation). It is deliberately separate from the required-action
 * (approval/response) path and is invoked only when the kernel is enabled.
 *
 * Absent → the runtime prints informational blocks to the terminal via the
 * existing render conventions. A client that wants to route them elsewhere (or
 * ignore them entirely and stay compatible) may supply its own sink.
 */
export type KernelInfoSink = (block: InfoBlock) => void;

export interface IncidentPolicy extends FirewallPolicy, TestEvidencePolicy {
  kernel?: KernelPolicy;
  /** Optional consumer of informational kernel blocks. */
  onKernelInfo?: KernelInfoSink;
  /** What to do about a credential in a payload. Default: block. */
  secretPolicy?: SecretPolicy;
  /** Refuse every write without asking - a full run with nothing at stake. */
  rehearse?: boolean;
  /** Append-only record of what was decided. */
  journal?: Journal;
}

export interface IncidentResult {
  turns: number;
  finalOutput: string;
  status: 'done';
  attempts: number;
  workspaceEpoch: number;
  evidence: EvidenceSummary;
  /** Present only when the adaptive kernel is enabled. */
  contract?: TaskContract;
  kernelMetrics?: KernelMetrics;
  /** True when a claimed success was blocked and rewritten by verification. */
  falseCompletionBlocked?: boolean;
}

/** Drive one incident through bounded required-action continuations. */
export async function runIncident(
  client: TrueForge,
  sessionId: string,
  brief: string,
  policy: IncidentPolicy,
): Promise<IncidentResult> {
  let input: TurnInput[] = [{ type: 'user.message', content: brief }];
  let finalOutput = '';
  const evidence = new EvidenceLedger({
    targetedCommand: policy.targetedCommand,
    fullSuiteCommand: policy.fullSuiteCommand,
    trustedExecutionTool: policy.trustedExecutionTool,
  });
  const gate = new ToolCallGate(policy, evidence);

  // Informational kernel state is additive and never gates anything. Default to
  // terminal output via the existing render conventions; a client may override.
  const emitInfo: KernelInfoSink =
    policy.onKernelInfo ??
    ((block) => {
      const text = renderBlock(block);
      if (text) console.log(`\n${text}`);
    });

  // Adaptive kernel is additive and opt-in: absent config keeps legacy behavior.
  const kernel = policy.kernel?.enabled
    ? new AdaptiveAgentKernel({
        enabled: true,
        policyVersion: policy.policyVersion,
        requireTestEvidence: policy.requireTestEvidence,
        writePaths: policy.writePaths,
        targetRepo: policy.targetRepo,
        baseBranch: policy.baseBranch,
        modelLimits: policy.kernel.modelLimits,
      })
    : undefined;
  const contract = kernel?.admit(brief, sessionId);
  if (kernel && contract) {
    // Surface the task objective/status, the planned context budget, and the
    // initial phase/plan snapshot the moment the contract is bound.
    emitInfo(renderTaskObjective(contract));
    emitInfo(renderContextPlan(kernel.contextPlan()));
    emitInfo(renderPhaseAndPlan(kernel.workingState()));
  }
  if (kernel && contract && !contract.bypassed) {
    kernel.recordState({ type: 'phase_changed', phase: 'executing' });
    emitInfo(renderPhaseAndPlan(kernel.workingState()));
  }

  for (let turnNumber = 1; turnNumber <= MAX_TURNS; turnNumber++) {
    const result = await streamTurn(client, sessionId, input, policy, evidence);
    finalOutput = result.output || finalOutput;

    if (result.status !== 'done') {
      if (result.status === 'error') {
        throw new Error(`TrueForge turn failed${result.statusMessage ? `: ${result.statusMessage}` : '.'}`);
      }
      if (result.status === 'cancelled') {
        throw new Error(`TrueForge turn was cancelled${result.statusMessage ? `: ${result.statusMessage}` : '.'}`);
      }
      throw new Error(`Turn ended in non-success state ${result.status}; buffered actions were discarded.`);
    }

    if (result.pending.length === 0) {
      console.log(`\n${style.dim('Turn finished with status: done')}`);
      // Generic completion verification: for action tasks, a claimed success
      // without verified evidence / with pending or unknown work is rewritten
      // into a truthful incomplete result. Simple questions are unaffected.
      let verifiedOutput = finalOutput;
      let falseCompletionBlocked: boolean | undefined;
      if (kernel && contract) {
        const unknownWrites = gate.attempts.filter((a) => a.state === 'unknown').length;
        // Project the ledger's verified facts into the kernel's working state
        // BEFORE verification. Without this, no criterion can ever leave the
        // remaining set: admission seeds them all, only criterion_satisfied
        // events clear them, and nothing ever emitted those - so every action
        // task was rewritten as incomplete even with a fully green evidence
        // ledger. The mapping is evidence-driven, never prose-driven: each
        // harness-inferred criterion is satisfied by exactly the typed
        // evidence that vouches for it, at the current workspace epoch.
        projectEvidenceIntoKernel(kernel, contract, evidence.summary());
        const decision = kernel.verify(finalOutput, evidence.summary(), 0, unknownWrites);
        verifiedOutput = decision.output;
        falseCompletionBlocked = decision.falseCompletionBlocked;
        emitInfo(renderVerification(decision));
        if (decision.satisfied && !contract.bypassed) {
          kernel.recordState({ type: 'phase_changed', phase: 'complete' });
          emitInfo(renderPhaseAndPlan(kernel.workingState()));
        }
      }
      return {
        turns: turnNumber,
        finalOutput: verifiedOutput,
        status: 'done',
        attempts: gate.attempts.length,
        workspaceEpoch: evidence.workspaceEpoch,
        evidence: evidence.summary(),
        ...(kernel && contract ? { contract } : {}),
        ...(kernel ? { kernelMetrics: kernel.metrics } : {}),
        ...(falseCompletionBlocked !== undefined ? { falseCompletionBlocked } : {}),
      };
    }

    if (turnNumber === MAX_TURNS) {
      throw new Error(`Incident did not settle within the ${MAX_TURNS}-turn continuation ceiling.`);
    }

    const approvals = result.pending.filter((action) => action.kind === 'approval');
    const responses = result.pending.filter((action) => action.kind === 'response');
    if (kernel && contract && !contract.bypassed) {
      kernel.recordState({ type: 'phase_changed', phase: 'blocked' });
      emitInfo(renderPhaseAndPlan(kernel.workingState()));
    }
    const approvalDecisions = await requestClearance(approvals, gate, {
    secretPolicy: policy.secretPolicy,
    rehearse: policy.rehearse,
    journal: policy.journal,
  });
    const responseDecisions = await requestResponses(responses, gate);
    input = orderContinuationInputs(result.pending, approvalDecisions, responseDecisions);
    if (kernel && contract && !contract.bypassed) {
      kernel.recordState({ type: 'phase_changed', phase: 'executing' });
      emitInfo(renderPhaseAndPlan(kernel.workingState()));
    }
  }

  throw new Error('Incident continuation loop exited unexpectedly.');
}

export function orderContinuationInputs(
  pending: readonly PendingAction[],
  approvalDecisions: readonly TurnInput[],
  responseDecisions: readonly TurnInput[],
): TurnInput[] {
  const approvals = [...approvalDecisions];
  const responses = [...responseDecisions];
  const ordered = pending.map((action): TurnInput => {
    const candidates = action.kind === 'approval' ? approvals : responses;
    const expectedType = action.kind === 'approval' ? 'user.tool_approval' : 'user.tool_response';
    const index = candidates.findIndex((decision) => {
      const value = object(decision);
      return (
        value?.type === expectedType &&
        value.threadId === action.invocation.key.threadId &&
        value.toolCallId === action.invocation.key.toolCallId
      );
    });
    if (index < 0) {
      throw new Error(
        `No ${expectedType} result exists for ${action.invocation.key.threadId}/${action.invocation.key.toolCallId}.`,
      );
    }
    const [decision] = candidates.splice(index, 1);
    if (!decision) throw new Error('Continuation decision unexpectedly disappeared.');
    return decision;
  });

  if (approvals.length > 0 || responses.length > 0) {
    throw new Error('Continuation produced a decision without a corresponding required action.');
  }
  return ordered;
}

interface StreamTurnResult {
  pending: PendingAction[];
  output: string;
  status: string;
  statusMessage?: string;
}

async function streamTurn(
  client: TrueForge,
  sessionId: string,
  input: TurnInput[],
  policy: IncidentPolicy,
  evidence: EvidenceLedger,
): Promise<StreamTurnResult> {
  const stream = await client.sessions.createTurnStream(sessionId, { input });
  const eventsById = new Map<string, StreamEvent>();
  const pendingEvents = new Map<string, StreamEvent>();
  const openThreads = new Set<string>();
  let turnId = 'unknown';
  let streamingText = false;
  let output = '';
  let status = 'unknown';
  let statusMessage: string | undefined;

  const endText = () => {
    if (streamingText) {
      process.stdout.write('\n');
      streamingText = false;
    }
  };

  for await (const { data } of stream.withMetadata()) {
    const event = data as unknown as StreamEvent;
    if (event.id) eventsById.set(event.id, event);

    switch (event.type) {
      case 'turn.created':
        turnId = String(event.turnId ?? event.turn_id ?? event.id ?? 'unknown');
        console.log(style.dim('\n· turn started'));
        break;

      case 'mcp.initialize': {
        const names = mcpServersOf(event).map(labelOf);
        console.log(style.dim(`· connected to ${names.join(', ') || 'an MCP server'}`));
        break;
      }

      case 'mcp.auth_required': {
        endText();
        const servers = mcpServersOf(event);
        if (servers.length === 0) console.log(style.yellow('· a connector needs authorization'));
        for (const server of servers) {
          console.log(style.yellow(`· connector ${style.bold(labelOf(server))} needs authorization`));
          const url = server.auth_url ?? server.authUrl;
          if (url) console.log(style.yellow(`  authorize: ${url}`));
        }
        break;
      }

      case 'thread.created': {
        const id = String(event.id ?? event.threadId ?? event.thread_id ?? '');
        if (id && id !== 'main' && !openThreads.has(id)) {
          openThreads.add(id);
          endText();
          console.log(style.blue(`· subagent started (${id.slice(0, 8)})`));
        }
        break;
      }

      case 'thread.done': {
        const id = String(event.id ?? event.threadId ?? event.thread_id ?? '');
        if (openThreads.delete(id)) {
          endText();
          console.log(style.blue(`· subagent finished (${id.slice(0, 8)})`));
        }
        break;
      }

      case 'model.message': {
        for (const call of toolCallsOf(event)) {
          const invocation = invocationFromCall(sessionId, turnId, event, call, policy);
          evidence.observeInvocation(invocation);
          endText();
          console.log(`${style.cyan('· tool')} ${summarizeInline(call.name, call.arguments)}`);
        }
        break;
      }

      case 'model.message.delta':
        if (typeof event.content === 'string' && event.content) {
          streamingText = true;
          process.stdout.write(event.content);
        }
        break;

      case 'tool.response': {
        endText();
        const callId = stringValue(event.toolCallId ?? event.tool_call_id);
        if (callId) {
          evidence.observeResponseForCall(
            sessionId,
            threadIdOf(event),
            callId,
            evidencePayload(event),
          );
        }
        console.log(style.dim(`  ↳ ${preview(event.content ?? event.output, 240)}`));
        break;
      }

      case 'tool.approval_required':
      case 'tool.response_required':
        endText();
        pendingEvents.set(requiredActionIdentity(event), event);
        break;

      case 'turn.done': {
        endText();
        const state = object(event.state);
        status = stringValue(state?.status) ?? 'unknown';
        statusMessage = stringValue(state?.message ?? state?.reason);
        output = outputContent(state?.output);
        const actions = state?.requiredActions ?? state?.required_actions;
        if (Array.isArray(actions)) {
          for (const value of actions) {
            const action = object(value) as StreamEvent | undefined;
            if (
              action &&
              (action.type === 'tool.approval_required' || action.type === 'tool.response_required')
            ) {
              pendingEvents.set(requiredActionIdentity(action), action);
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }

  endText();
  const pending = [...pendingEvents.values()].flatMap((event) =>
    resolveRequiredAction(event, eventsById, {
      sessionId,
      turnId,
      policyVersion: policy.policyVersion,
    }),
  );
  return { pending, output, status, ...(statusMessage ? { statusMessage } : {}) };
}

export function invocationFromCall(
  sessionId: string,
  turnId: string,
  event: StreamEvent,
  call: ReturnType<typeof toolCallsOf>[number],
  policy: IncidentPolicy,
): ToolInvocation {
  const trusted = policy.trustedExecutionTool;
  const trustedExecutionProducer =
    trusted !== undefined &&
    call.toolSetId === trusted.toolSetId &&
    call.toolSetName === trusted.toolSetName &&
    call.toolType === trusted.toolType;
  return {
    key: { sessionId, turnId, threadId: threadIdOf(event), toolCallId: call.id },
    sourceEventId: event.id ?? 'unknown',
    origin: trustedExecutionProducer ? 'sandbox' : 'agent',
    toolSetId: call.toolSetId,
    toolSetName: call.toolSetName,
    toolType: call.toolType,
    toolName: call.name,
    arguments: call.arguments,
    policyVersion: policy.policyVersion,
    validationViolations: call.validationViolations,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function evidencePayload(event: StreamEvent): unknown {
  const facts = event.executionFacts ?? event.execution_facts;
  return facts === undefined ? event.content ?? event.output : { executionFacts: facts };
}

function outputContent(value: unknown): string {
  const output = object(value);
  const content = output?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const part = object(item);
        // A refusal is content too: the SDK permits both a top-level refusal
        // field on the message and refusal content parts. Dropping them turned
        // a successful refusal-only turn into empty output.
        return stringValue(part?.text) ?? stringValue(part?.refusal);
      })
      .filter((item): item is string => item !== undefined)
      .join('\n');
  }
  return stringValue(output?.refusal) ?? '';
}

interface McpServerRef {
  name?: string;
  id?: string;
  auth_url?: string;
  authUrl?: string;
}

function mcpServersOf(event: StreamEvent): McpServerRef[] {
  const servers = event.mcpServers ?? event.mcp_servers;
  return Array.isArray(servers) ? (servers as McpServerRef[]) : [];
}

function labelOf(server: McpServerRef): string {
  return server.name ?? server.id ?? '(unnamed)';
}

/**
 * Map each harness-inferred acceptance criterion onto the typed evidence that
 * vouches for it, then record satisfied criteria as working-state events.
 * Evidence-driven only: prose never clears a criterion.
 */
function projectEvidenceIntoKernel(
  kernel: AdaptiveAgentKernel,
  contract: TaskContract,
  evidence: EvidenceSummary,
): void {
  if (contract.bypassed) return;

  if (evidence.regressionObserved) {
    kernel.recordState({
      type: 'evidence_recorded',
      kind: 'regression_failure',
      atEpoch: evidence.workspaceEpoch,
    });
    // The red run precedes the fix by definition; a historical regression
    // record is the successful flow, not a reason to withhold the criterion.
    kernel.recordState({
      type: 'criterion_satisfied',
      text: HARNESS_INFERRED_CRITERIA.regressionReproduced,
    });
  }
  if (evidence.targetedTestPassed && evidence.fullSuitePassed) {
    const satisfied: Record<string, string> = {
      bug_fix: HARNESS_INFERRED_CRITERIA.fixTurnsTestGreen,
      feature: HARNESS_INFERRED_CRITERIA.featureCovered,
      refactor: HARNESS_INFERRED_CRITERIA.refactorStillGreen,
    };
    const text = satisfied[contract.taskType];
    if (text) {
      kernel.recordState({ type: 'criterion_satisfied', text });
    }
  }
  // User-stated criteria are not implied by the generic evidence kinds; they
  // clear only when the evidence ledger explicitly vouches for them, which
  // today it has no way to express. Left in the remaining set, they surface as
  // missing at the verification boundary - the honest outcome.
}
