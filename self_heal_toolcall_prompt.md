
You are working inside the truefoundry/trueforge repository.

This is an implementation task, not a design-only exercise. Inspect the current repository, establish a baseline, design against the existing abstractions, implement the feature end-to-end, add tests, run benchmarks, and report measured before/after results.

Do not stop after producing an architecture document. Do not leave unused interfaces or disconnected abstractions. Every new component must be integrated into the real agent execution path.

Do not create commits unless explicitly requested.

## 1. Mission

Make a material step-change in TrueForge harness quality so that, with the same model and user prompt, agents:

1. Understand the task and completion criteria more accurately before acting.
2. Retrieve more relevant context with fewer unnecessary tokens.
3. Select valid tools and arguments more reliably.
4. Avoid repeated or non-progressing tool loops.
5. Recover from deterministic failures through structured repair or replanning.
6. Delegate bounded work to subagents without duplication or authority expansion.
7. Preserve important state through long sessions and compaction.
8. Verify completion from typed evidence instead of model confidence.
9. Produce fewer false-success responses.
10. Remain vendor-neutral, policy-safe, resumable, and observable.

The desired result is not â€œa better system prompt.â€ The desired result is a better runtime around the model.

Call this feature:

    TrueForge Adaptive Agent Kernel

Its major components should be:

- RequestCompiler
- TaskContractLedger
- WorkingStateProjector
- AdaptiveContextManager
- ToolCapabilityRegistry
- ToolExecutionCoordinator
- ProgressAndRecoveryController
- DelegationCoordinator
- VerificationCoordinator
- HarnessEvaluationSuite

Adapt these names to existing repository conventions if the codebase already has better canonical terminology.

## 2. Research basis and design constraints

Use the public repositories only as architectural references. Do not copy implementation code.

Confirmed current TrueForge seams include:

- packages/trueforge-core/src/core/mcp/executeToolCalls.ts
- packages/trueforge-core/src/core/mcp/ToolSet.ts
- packages/trueforge-core/src/core/capabilities/AgentContextProcessor.ts
- packages/trueforge-core/src/core/capabilities/ToolResponseProcessor.ts
- packages/trueforge-core/src/core/capabilities/builtins/ContextCompaction.ts
- packages/trueforge-core/src/core/capabilities/builtins/DynamicSubAgents.ts
- packages/trueforge-core/src/core/sandbox/codeMode/CodeModeDispatcher.ts
- packages/trueforge-core/src/agent-session/schemas/events.ts
- packages/trueforge-core/src/agent-session/store/
- benchmark/

Verify all paths and behavior against the current checkout before editing.

Relevant public patterns to learn from:

1. OpenCode:
   - Role-specific primary and subagents.
   - Scoped permission rules.
   - Before/after tool hooks.
   - Durable tool-call state and metadata.
   - Recent-tail preservation during compaction.
   - Old tool-output pruning.
   - Resumable child sessions.
   - Explicit plan/build execution modes.
   - Output truncation with recoverable artifact locations.

2. DeepSeek Harness:
   - Durable event log as the source of model-visible state.
   - Plugin-based pre-execute, execute, post-execute, and result stages.
   - Immutable execution identity.
   - Canonical tool output contracts.
   - Explicit prepare, dispatch, and finalize phases.
   - Tool-level concurrency declarations.
   - Nested call identity and parent/root call tracking.
   - Request, step, turn, and cancellation boundaries.
   - Repeat-call detection based on canonical arguments.
   - Capability seams instead of special cases in the loop.

3. Claude Code public repository:
   - Hooks and permission interception.
   - Specialized agents and workflows.
   - Explicit discovery, architecture, implementation, and review phases.
   - Sandbox and managed-settings policy.
   - Plugin-based extensibility.

Do not claim knowledge of Claude Code internals that are not present in Anthropicâ€™s public repository or official documentation.

## 3. Mandatory architectural invariants

The implementation must preserve these invariants:

1. Every model-visible input must be reconstructable from persisted session events.
2. Every tool execution route must pass through one canonical coordinator.
3. Existing TrueForge tool selector, approval, authentication, and sandbox policies may only be preserved or tightened.
4. Application capabilities may not bypass core policy.
5. Every model-generated tool call must receive exactly one corresponding model-visible result, including blocked, malformed, unknown, cancelled, and failed calls.
6. Tool identity must include stable tool-set/server identity, tool name, session, turn, thread, call ID, and nested parent/root identity where applicable.
7. Semantic changes to tool arguments invalidate prior approvals.
8. Human denial is terminal for the denied operation lineage unless a new user action explicitly reopens it.
9. Side-effecting calls with ambiguous completion state are never blindly retried.
10. Context compaction must preserve unresolved work, user constraints, approval state, errors, and completion criteria.
11. Subagents must never gain permissions unavailable to their parent.
12. Model-generated prose is not execution evidence.
13. Hidden chain-of-thought must not be persisted or requested. Persist only concise, externally useful task state, decisions, facts, and evidence.
14. Unknown policy, schema, identity, and execution states fail closed.
15. New behavior must work with SQLite and Postgres storage modes.
16. Generated OpenAPI and SDK code must be regenerated through repository scripts, never manually edited.
17. Existing API behavior must remain backward-compatible unless a migration is explicitly designed and tested.

## 4. Phase 0 â€” Repository understanding and baseline

Before implementation:

1. Read repository steering files and package-specific AGENTS.md/CLAUDE.md files.
2. Trace the full agent lifecycle:
   - Session creation
   - User input admission
   - Prompt/context assembly
   - LLM invocation
   - Tool-call parsing
   - Approval/auth/client-response handling
   - Tool execution
   - Tool-result insertion
   - Subagent creation
   - Code Mode nested execution
   - Context compaction
   - Turn completion, failure, cancellation, and restart
3. Identify every direct IToolSet.callTool(), ToolSource.callTool(), local/system-tool execution, client-side handoff, deferred-tool path, and Code Mode dispatch.
4. Map current event schemas and session-store behavior.
5. Map current OpenAPI/SDK generation workflow.
6. Run the existing unit, integration, type, lint, and build checks.
7. Run or prepare the existing benchmark baseline before changing behavior.

Write a concise internal implementation map containing:

- Execution entry points
- Persistence boundaries
- Context processors
- Policy boundaries
- Tool-call routes
- Generated-code boundaries
- Current benchmark commands
- Risks and migration points

Do not ask the user to make decisions that can be answered from repository conventions.

## 5. Phase 1 â€” Canonical task contract

Introduce a durable, schema-validated TaskContract representing what the harness believes the user asked it to accomplish.

Use the existing canonical schema library, likely Zod, rather than handwritten duplicate SDK interfaces.

Suggested logical contract:

interface TaskContract {
  version: number;
  taskId: string;
  objective: string;
  taskType:
    | 'question'
    | 'investigation'
    | 'bug_fix'
    | 'feature'
    | 'refactor'
    | 'operation'
    | 'unknown';
  constraints: TaskConstraint[];
  acceptanceCriteria: AcceptanceCriterion[];
  requiredEvidence: EvidenceRequirement[];
  referencedResources: ResourceReference[];
  ambiguities: TaskAmbiguity[];
  risk: 'low' | 'medium' | 'high' | 'unknown';
  status:
    | 'draft'
    | 'active'
    | 'blocked'
    | 'satisfied'
    | 'cancelled';
  revision: number;
}

Requirements:

1. Preserve the original user message unchanged.
2. Compile a contract only when the request is complex enough to benefit from it.
3. Simple conversational questions must not incur an unnecessary second model call.
4. Use deterministic extraction where possible:
   - Explicit file references
   - Repository/workspace references
   - Mentioned commands
   - Stated prohibitions
   - Output format
   - Explicit success criteria
5. For complex or ambiguous tasks, allow an optional structured model-assisted compilation pass using:
   - A schema-constrained response
   - No tools
   - A bounded token budget
   - A configurable small/default model
6. Compiler failure must not destroy the turn. Produce a conservative fallback contract and mark uncertainty.
7. Ask the user only when an ambiguity blocks safe or correct execution.
8. User corrections create a new contract revision rather than mutating history.
9. Persist the contract through canonical events.
10. Inject a concise contract projection into model context with explicit provenance.
11. Never convert untrusted repository content into a user constraint.
12. Differentiate:
    - User-authored requirements
    - Harness-inferred requirements
    - Policy-imposed constraints
    - Tool-discovered facts

Add durable informational events using repository naming conventions, conceptually:

- task.contract_created
- task.contract_updated
- task.contract_blocked
- task.contract_satisfied

If the repository prefers a single state event with revisions, follow that convention.

## 6. Phase 2 â€” Durable working-state ledger

Add a WorkingState model that captures externally useful progress without storing hidden reasoning.

Suggested logical shape:

interface WorkingState {
  taskId: string;
  contractRevision: number;
  phase:
    | 'understanding'
    | 'retrieving'
    | 'planning'
    | 'executing'
    | 'verifying'
    | 'blocked'
    | 'complete';
  plan: PlanStep[];
  activeStepIds: string[];
  observedFacts: ObservedFact[];
  touchedResources: ResourceMutation[];
  attemptedApproaches: AttemptSummary[];
  unresolvedErrors: StructuredFailure[];
  evidence: EvidenceRecord[];
  remainingCriteria: string[];
  updatedAt: string;
}

Rules:

1. State is event-derived and rebuildable after restart.
2. State updates must be compact and schema-validated.
3. Facts require provenance:
   - User statement
   - Tool result
   - Repository content
   - Policy
   - Model inference
4. Model inference must never be promoted to verified fact without evidence.
5. Record failure classes and attempted approaches so compaction does not cause repeated mistakes.
6. Preserve active work, blockers, and remaining criteria through context compaction.
7. Do not persist raw secrets, full command output, full repository content, or hidden reasoning.
8. Keep large artifacts in existing offload/spill storage and retain only typed locators/digests.
9. Add projection functions for:
   - Model context
   - API/SDK consumers
   - UI
   - Telemetry
10. The model-visible projection must be generated from durable state, not an independent mutable cache.

## 7. Phase 3 â€” Adaptive context manager

Replace single-strategy conversation summarization with a layered context-budget planner.

Do not remove existing compaction compatibility immediately. Add a migration path and feature flag.

The new context planner should divide context into:

1. Pinned context:
   - Current TaskContract
   - Current WorkingState
   - Latest explicit user constraints
   - Active approvals/auth requirements
   - Unresolved errors
   - Current plan step
   - Current verification requirements

2. Recent tail:
   - Preserve recent complete turns within a configurable token budget.
   - Never split a tool call from its corresponding result.
   - Preserve current turn and immediately preceding causal context.

3. Relevant historical context:
   - Select older events based on task/resource/tool/error relevance.
   - Prefer deterministic lexical, identifier, path, and provenance scoring initially.
   - Do not add an embedding dependency unless the repository already has an appropriate provider seam.
   - Make retrieval strategy replaceable.

4. Compacted history:
   - Summarize older completed work into a strict schema.
   - Preserve decisions, files, symbols, errors, failed approaches, and evidence.
   - Avoid full code snippets unless still needed.
   - Never summarize an unresolved approval, tool call, or error out of existence.

5. Offloaded artifacts:
   - Large tool outputs, logs, and generated files remain outside model context.
   - Include bounded previews plus retrievable locators.
   - Protect outputs explicitly marked as high-value evidence.

Implement:

interface ContextBudgetPlan {
  contextWindow: number;
  reservedOutputTokens: number;
  pinnedBudget: number;
  recentTailBudget: number;
  relevantHistoryBudget: number;
  toolSchemaBudget: number;
  safetyMargin: number;
}

Requirements:

- Use the selected modelâ€™s actual context and output limits.
- Track estimated versus observed token use.
- Perform tool-output pruning before whole-history summarization.
- Preserve a configurable number or token budget of recent turns.
- Avoid repeatedly summarizing prior summaries.
- Store compaction provenance and source-event ranges.
- Make compaction deterministic enough to test with fixtures.
- Add adversarial tests for:
  - Unresolved tool calls
  - Pending approvals
  - Interrupted turns
  - Large attachments
  - Repeated compaction
  - Model switches
  - Subagent results
  - Old failed approaches
  - Current verification evidence

## 8. Phase 4 â€” ToolCapabilityRegistry

Extend tool metadata beyond JSON input schemas.

The harness needs host-owned execution semantics unavailable to the model.

Suggested logical metadata:

type SideEffectClass =
  | 'read_only'
  | 'workspace_write'
  | 'remote_write'
  | 'destructive'
  | 'unknown';

type RetryCapability =
  | 'safe'
  | 'native_idempotency'
  | 'reconcile_before_retry'
  | 'never';

interface ToolCapability {
  stableToolSetId: string;
  toolName: string;
  sideEffectClass: SideEffectClass;
  retryCapability: RetryCapability;
  concurrency:
    | { kind: 'parallel_safe' }
    | { kind: 'exclusive' }
    | { kind: 'resource_scoped'; resources: string[] };
  timeoutMs?: number;
  outputSchema?: unknown;
  resultSizeClass?: 'small' | 'medium' | 'large' | 'unknown';
  evidenceCapabilities: string[];
  sensitiveArgumentPaths: string[];
  tags: string[];
}

Rules:

1. Metadata is host-owned and not trusted merely because an MCP server claims it.
2. MCP annotations may contribute hints but cannot weaken host policy.
3. Unknown side effects default to exclusive execution and no automatic retry.
4. Existing tools without metadata receive conservative defaults.
5. Tool definitions should be able to provide canonical output schemas.
6. Successful output should be validated before becoming typed evidence.
7. Tool presentation metadata must be replayable and derived only from durable inputs/results.
8. Capability registration must support:
   - Remote MCP tools
   - Local/system tools
   - Sandbox tools
   - Client-side tools
   - Deferred tools
   - Dynamic subagent tools
   - Code Mode nested calls

## 9. Phase 5 â€” Central ToolExecutionCoordinator

Introduce one canonical execution service:

interface ToolExecutionCoordinator {
  prepareBatch(
    invocations: readonly ToolInvocation[],
    context: ExecutionContext,
  ): Promise<PreparedBatch>;

  execute(
    prepared: PreparedToolInvocation,
  ): Promise<ToolExecutionOutcome>;

  reconcile(
    attempt: ToolAttemptRecord,
  ): Promise<ReconciliationOutcome>;
}

All execution routes must use it.

At minimum, migrate:

- executeToolCalls.ts
- ToolSet.ts delegation
- Local/system tools
- Sandbox execution
- CodeModeDispatcher.ts
- Client-side tool handoff
- Deferred tools
- Dynamic subagent creation
- Any direct IToolSet.callTool() path

Direct underlying execution should become internal or guarded so future code cannot accidentally bypass the coordinator.

Pipeline:

    Resolve
      â†’ Decode
      â†’ Schema validate
      â†’ Core policy
      â†’ Capability policy
      â†’ Repair/replay check
      â†’ Approval/auth/client-response resolution
      â†’ Concurrency scheduling
      â†’ Dispatch
      â†’ Typed outcome normalization
      â†’ Post-execution policy
      â†’ Evidence extraction
      â†’ Durable event emission
      â†’ Model-facing result projection

Model this as explicit phases:

- prepare
- dispatch
- finalize

Preparation requirements:

1. Resolve exact tool-set/server identity.
2. Preserve session, turn, thread, model-message, call, root-call, and parent-call identity.
3. Parse JSON without falling back to {}.
4. Validate against the canonical discovered schema.
5. Produce field-level violations.
6. Run core policy before application interceptors.
7. Bind approval to exact identity, canonical arguments, policy version, and stable tool origin.
8. Persist preparation/approval state before side effects.
9. Preflight every call in a parallel batch before starting any side-effecting member.

Scheduling requirements:

1. Parallelize only calls explicitly classified as safe.
2. Exclusive calls form ordering barriers.
3. Resource-scoped calls may overlap only when resource sets do not conflict.
4. Unknown tools are exclusive.
5. Preserve result ordering by original model call order.
6. Cancellation must propagate into every running call.
7. Cancellation before dispatch must be distinguishable from cancellation after dispatch.

Outcome:

interface ToolExecutionOutcome {
  invocationKey: ToolInvocationKey;
  attemptId: string;
  status: 'succeeded' | 'failed' | 'unknown';
  failureClass?: FailureClass;
  startedAt: string;
  completedAt: string;
  response: CallToolResult;
  executionFacts?: {
    exitCode?: number;
    timedOut?: boolean;
    signal?: string;
    sideEffectCommitted?: boolean;
    idempotencyKey?: string;
  };
  evidence: EvidenceRecord[];
}

Never derive success from rendered prose.

## 10. Phase 6 â€” Structured repair and causal recovery

Create a ProgressAndRecoveryController that distinguishes:

- Argument repair
- Transport retry
- Reconciliation
- Replanning
- Human escalation
- Terminal denial

Required behavior:

1. Invalid JSON, missing required fields, and safe representational errors may receive structured repair feedback.
2. Repair never mutates the original call.
3. A correction must:
   - Have a new call ID
   - Occur in a later model continuation
   - Match exactly one active repair lineage
4. Same-batch siblings cannot count as corrections.
5. Human denial terminates the lineage.
6. Semantic argument changes invalidate approval.
7. Read-only pre-dispatch failures may retry within a host-owned budget.
8. Remote writes use native idempotency or reconciliation.
9. Destructive calls are never automatically retried.
10. Timeout/disconnect after write dispatch becomes unknown until reconciled.
11. Every blocked or repair-requested call still receives a model-visible tool result.
12. Repair budgets belong to the host, not the model.

Add progress detection based on:

- Canonical tool name and arguments fingerprint
- Result digest
- Failure class
- Working-state change
- Evidence change
- Resource mutation
- Plan-step transition

Detect both:

- Exact repetition
- Semantically equivalent non-progress loops

Recommended initial policy:

- First repeated no-progress attempt: structured reminder
- Second repeated no-progress attempt: force replan
- Third repeated no-progress attempt: stop or require human review
- Global configurable step/turn ceiling
- No count reset from irrelevant tool calls

Do not rely only on prompt instructions to stop loops.

## 11. Phase 7 â€” Adaptive tool presentation and selection

Do not expose every available tool to the model on every step when the tool surface is large.

Build a replaceable ToolSelectionPolicy that chooses the step-visible tool set from:

- Task type
- Current plan step
- Tool tags
- Referenced resources
- Previous failures
- Current permissions
- Tool cost
- Tool schema size
- Deferred loading state

Requirements:

1. Preserve explicitly preloaded tools.
2. Preserve tools required by active approvals or repair chains.
3. Never hide the route needed to discover/load another tool.
4. Fall back safely when confidence is low.
5. Record which tools were selected and why.
6. Include tool-schema token cost in context budgeting.
7. Measure:
   - Tools presented per step
   - Schema tokens
   - Unknown-tool attempts
   - Tool selection misses
8. Keep Code Mode as an optional presentation/execution strategy, not a policy bypass.
9. Nested Code Mode calls must use deterministic identities such as:
   code:<root-call-id>:<sequence>
10. Nested calls inherit parent policy and may only tighten permissions.

## 12. Phase 8 â€” Better subagent delegation

Upgrade DynamicSubAgents from prompt-only delegation to typed, least-privilege delegation.

Suggested contract:

interface DelegationContract {
  parentTaskId: string;
  delegationId: string;
  objective: string;
  constraints: string[];
  expectedOutput: OutputRequirement[];
  allowedToolCapabilities: string[];
  deniedToolCapabilities: string[];
  resourceOwnership: string[];
  evidenceRequirements: EvidenceRequirement[];
  deadline?: string;
  maxSteps: number;
  maxDepth: number;
}

Requirements:

1. A subagent receives only the necessary task context.
2. It does not receive the entire parent conversation by default.
3. It receives a projected TaskContract and relevant WorkingState.
4. Its permissions are the intersection of:
   - Parent permissions
   - Subagent profile permissions
   - Delegation-specific restrictions
5. It may never widen parent authority.
6. Parent and subagent resource ownership must prevent overlapping writes unless explicitly allowed.
7. Background work must be used only for independent tasks.
8. The parent must not poll, duplicate, or edit the same owned resources while a background task is active.
9. Subagent outputs must be schema-validated and contain:
   - Result summary
   - Claims
   - Evidence references
   - Files/resources inspected
   - Files/resources changed
   - Unresolved questions
   - Recommended next action
10. Support resumable child sessions.
11. Enforce maximum delegation depth.
12. Persist parent-child lineage.
13. Cancellation propagates to children.
14. Child failures become typed outcomes, not prose-only summaries.

## 13. Phase 9 â€” VerificationCoordinator

Introduce a generic verification seam rather than hardcoding software-development tests into the core.

interface Verifier {
  id: string;
  applies(contract: TaskContract): boolean;
  evaluate(input: VerificationInput): Promise<VerificationResult>;
}

interface VerificationResult {
  verifierId: string;
  status: 'passed' | 'failed' | 'missing' | 'stale' | 'unknown';
  criteria: CriterionResult[];
  evidenceIds: string[];
  observedAt: string;
  workspaceEpoch?: number;
}

Provide built-in generic verifiers for:

- Required acceptance criteria accounted for
- Required tool evidence present
- No unresolved errors
- No unknown side-effect outcomes
- No pending approval/auth/client response
- Current policy version
- Current workspace/repository epoch
- Required output format

Allow application-specific verifiers for:

- Unit tests
- Type checks
- Builds
- Repository state
- Remote deployment checks
- Data validation

Completion rules:

1. The model may propose completion.
2. The harness determines whether the contract can become satisfied.
3. Conversational questions must remain lightweight and should not require unnecessary verifiers.
4. For action tasks, a final successful state requires all required verifiers to pass.
5. Missing evidence must be displayed truthfully.
6. Unstructured output that mentions success is not verified evidence.
7. A later workspace/repository mutation invalidates stale evidence.
8. A false-success final answer must be blocked or rewritten into a truthful incomplete/blocked result.

## 14. Phase 10 â€” Prompt assembly

Refactor system-prompt construction into ordered, provenance-aware sections.

Suggested order:

1. Core identity and universal safety rules
2. Core tool/policy semantics
3. TaskContract
4. Current WorkingState
5. Current plan step
6. Environment/workspace facts
7. Relevant project instructions
8. Tool-specific guidance
9. Verification requirements
10. Recovery/replan notices
11. Recent user input

Requirements:

- Every section has:
  - Stable identifier
  - Source/provenance
  - Priority
  - Token estimate
  - Persistence policy
  - Redaction policy
- Deduplicate repeated instructions.
- Do not repeat large static policy on every internal subagent if a smaller projection suffices.
- Preserve provider neutrality.
- Provider adapters may transform presentation but not change semantics.
- Make final assembled prompt inspectable in debug mode with secrets redacted.
- Add tests proving section ordering and precedence.
- User content and repository content cannot override core policy sections.

## 15. Phase 11 â€” Durable events, APIs, SDK, and UI

Add canonical events for observability, conceptually:

- task.contract_updated
- task.state_updated
- context.plan_created
- context.compacted
- tool.prepared
- tool.gate_decision
- tool.attempt_started
- tool.attempt_completed
- tool.reconciliation_required
- tool.repair_requested
- tool.replan_required
- verification.updated
- delegation.started
- delegation.completed

Follow existing naming and schema conventions.

Requirements:

1. Add canonical Zod schemas in TrueForge core.
2. Persist through existing session stores.
3. Verify SQLite/Postgres parity.
4. Regenerate OpenAPI.
5. Regenerate TypeScript SDK types.
6. Do not hand-edit generated files.
7. Update UI components to display:
   - Task objective
   - Current phase
   - Plan progress
   - Context/compaction state
   - Repair/replan notices
   - Verification status
   - Subagent ownership/status
   - Unknown write/reconciliation blockers
8. Preserve compatibility for clients that ignore the new informational events.
9. Required actions remain distinct from informational events.
10. Add event replay and reconnect tests.

## 16. Migration and rollout

Introduce a top-level configuration such as:

adaptiveExecution: {
  enabled: boolean;
  requestCompiler: { ... };
  workingState: { ... };
  adaptiveContext: { ... };
  toolCoordinator: { ... };
  progressController: { ... };
  verification: { ... };
}

Use existing configuration conventions.

Rollout requirements:

1. Preserve existing behavior when disabled.
2. Enable individual components for testing.
3. Provide a â€œshadow modeâ€ where practical:
   - Compute decisions
   - Record metrics
   - Do not alter execution
4. Compare legacy and adaptive behavior using deterministic fixtures.
5. After benchmarks establish non-regression, make the new tool coordinator mandatory internally even if adaptive higher-level policies remain configurable.
6. Add migration documentation.
7. Avoid dual execution paths that can drift indefinitely.

## 17. Test requirements

Add targeted tests for at least:

### Request compilation

- Simple question avoids unnecessary compilation call
- Bug-fix prompt produces acceptance criteria
- Explicit constraints preserve exact meaning
- Ambiguity is marked rather than invented
- User correction creates a revision
- Prompt injection in repository content cannot become a user constraint
- Compiler timeout/failure falls back safely

### Working state

- Event replay reconstructs identical state
- Restart preserves active plan and blockers
- No hidden reasoning or raw secret persistence
- Evidence provenance remains intact
- Failed approaches survive compaction

### Context

- Recent tail preserved
- Tool call/result pairs remain together
- Active approval preserved
- Unresolved error preserved
- Old large tool output pruned/offloaded
- Relevant old fact retained
- Irrelevant old output dropped
- Repeated compaction does not compound summaries
- Model switch recalculates budgets
- Context remains under model limit

### Tool coordinator

- Unknown tool
- Invalid JSON
- Missing required field
- Schema mismatch
- Disabled tool
- Core approval required
- Human denial
- Auth required
- Client-side response required
- Interceptor timeout
- Cancellation before dispatch
- Cancellation after dispatch
- Read-only retry
- Native idempotency
- Reconciliation before retry
- Ambiguous non-idempotent write
- Parallel safe reads
- Conflicting writes serialized
- Batch preflight
- Nested Code Mode calls
- Dynamic subagent tool
- Exactly one model-visible result per call

### Progress/recovery

- Exact repeated call
- Equivalent repeated call
- Same arguments with new result
- Same result with no state change
- Repair in later turn
- Same-batch sibling rejected as repair
- Repair budget exhausted
- Replan changes approach
- Human denial terminal
- Irrelevant calls do not reset loop detection
- Global ceiling

### Subagents

- Least-privilege intersection
- Parent permission cannot be widened
- Depth limit
- Resource ownership conflict
- Background result delivery
- Cancellation propagation
- Child restart/resume
- Structured child result
- Parent does not duplicate child work

### Verification

- Complete evidence
- Missing evidence
- Stale evidence
- Fake success prose
- Timed-out command
- Unknown write outcome
- Later mutation invalidation
- False completion blocked
- Lightweight conversational answer unaffected

### Persistence and API

- SQLite/Postgres contract parity
- Event serialization
- SDK generated type compatibility
- Reconnect/replay
- Crash before dispatch
- Crash after dispatch
- Awaiting approval restart
- Executing write restart
- Terminal attempts never replayed

## 18. Benchmark and evaluation plan

Do not claim improvement without before/after measurement.

Use the existing TrueForge benchmark as one evaluation arm and add a deterministic harness-quality suite.

### Existing benchmark

Run the same:

- Model
- Model parameters
- Prompts
- MCP connectors
- Dataset
- Trial count
- Timeouts
- Judge
- Pricing configuration

Use at least five paired trials when budget allows. If external infrastructure prevents running the full benchmark, prepare the commands and run the deterministic suite; clearly mark the external benchmark as unverified.

### New deterministic harness-quality suite

Create fixtures covering:

1. Correct tool among many similar tools
2. Invalid JSON repair
3. Missing argument repair
4. Repository/context lookup
5. Large output retrieval
6. Repeated no-progress call
7. Plan correction after test failure
8. Parallel independent reads
9. Conflicting writes
10. Stale evidence
11. False-success prose
12. Human denial
13. Ambiguous remote write
14. Context compaction during active work
15. Subagent delegation and ownership
16. Restart while awaiting approval
17. Restart during unknown write state
18. Prompt injection inside tool/repository output
19. Model switch mid-session
20. Simple question latency

Capture:

- Task solved
- Criteria satisfied
- First valid tool-call rate
- Invalid argument count
- Unknown-tool count
- Tool calls per solved task
- Repeated-call count
- Repair count
- Replan count
- Human interventions
- False completion count
- Context tokens per step
- Tool-schema tokens per step
- Compaction count
- Cost
- Latency
- Deterministic harness overhead
- Policy violations
- Ambiguous writes automatically retried
- Evidence freshness failures

### Acceptance gates

The implementation is acceptable only if:

1. Existing tests pass.
2. Existing APIs remain compatible or have a tested migration.
3. Policy bypass count remains zero.
4. False verified-success count is zero.
5. Ambiguous non-idempotent writes automatically retried is zero.
6. Exactly one result exists for every model tool call.
7. First valid tool-call rate improves materially on the deterministic suite.
8. Repeated no-progress calls decrease by at least 50%.
9. Invalid argument calls decrease by at least 30%, or settle through bounded repair without extra human intervention.
10. Long-task context tokens decrease by at least 15% without reducing criteria satisfaction.
11. Deterministic coordinator overhead p95 remains below 100 ms, excluding model and tool/network time.
12. Simple conversational latency does not materially regress.
13. On at least one hard paired benchmark suite:
    - Solved-task rate improves over baseline, or
    - Solved-task rate is statistically non-inferior while token/tool cost improves by at least 20%.
14. No other benchmark arm suffers a material accuracy regression.
15. Report distributions and paired outcomes, not only a favorable single run.

Do not tune prompts against judge criteria or add task-specific hints.

## 19. Observability

Add metrics without raw arguments or user content in labels:

- harness_request_compilation_total{result,task_type}
- harness_task_contract_revisions_total
- harness_context_tokens{category}
- harness_context_items_selected_total{category}
- harness_tool_calls_total{tool_class,outcome}
- harness_tool_repairs_total{reason}
- harness_replans_total{reason}
- harness_repeat_calls_total{level}
- harness_reconciliation_total{outcome}
- harness_verification_total{status,verifier}
- harness_subagent_tasks_total{outcome}
- harness_false_completion_blocked_total
- harness_policy_fail_closed_total
- harness_coordinator_latency_ms
- harness_context_planning_latency_ms
- harness_task_completion_latency_ms

Tracing should connect:

session â†’ turn â†’ step â†’ model message â†’ root tool call â†’ nested tool calls â†’ attempt â†’ evidence â†’ verification.

Never place prompts, arguments, command output, secrets, file contents, or repository contents in metric labels.

## 20. Implementation order

Execute in this order:

1. Baseline repository tests and benchmark fixtures.
2. Architecture trace and migration map.
3. Canonical contracts and events.
4. Durable TaskContract and WorkingState projection.
5. ToolCapabilityRegistry.
6. ToolExecutionCoordinator with legacy behavior preserved.
7. Migrate every execution path to the coordinator.
8. Typed outcomes and persistence/recovery.
9. Progress/recovery controller.
10. Adaptive context planner and compaction migration.
11. Adaptive tool selection.
12. Subagent delegation contracts.
13. Verification coordinator.
14. SDK/OpenAPI regeneration.
15. UI integration.
16. Deterministic benchmark suite.
17. Existing benchmark A/B run.
18. Adversarial semantic review.
19. Fix findings.
20. Final full validation.

Do not build all interfaces first and defer integration. Each phase must connect immediately to the live execution path.

## 21. Required final validation

Run the repositoryâ€™s actual commands discovered during inspection, including:

- Targeted unit tests
- Integration tests
- Store contract tests
- SQLite/Postgres parity tests
- Typecheck
- Lint
- Build
- OpenAPI generation verification
- SDK generation verification
- UI tests
- Deterministic harness benchmark
- Existing benchmark where infrastructure permits

Run a semantic review focused on:

- Execution bypasses
- Approval identity
- Cancellation
- Crash recovery
- Stale context
- False evidence
- Prompt injection
- Subagent authority
- Retry safety
- Event replay
- Generated-schema drift

Fix all critical/high findings before completion.

## 22. Final report

Report:

1. Executive summary
2. Baseline behavior
3. Implemented architecture
4. Exact execution paths migrated
5. Events/schemas added
6. Persistence and recovery behavior
7. Context-selection strategy
8. Repair/replan behavior
9. Subagent authority model
10. Verification model
11. Files changed
12. Tests run and results
13. Before/after benchmark table
14. Accuracy, cost, tokens, tool calls, repair, repeat, and latency changes
15. Remaining limitations
16. Rollout recommendation
17. Features still behind flags
18. Anything that could not be independently verified

Do not describe the task as complete merely because the code compiles. Verify the result against every acceptance gate above.

## 23. Non-goals and prohibitions

- Do not replace TrueForge with OpenCode, DeepSeek Harness, LangGraph, or another framework.
- Do not copy code from reference repositories.
- Do not depend on leaked or reconstructed Claude Code source.
- Do not make the harness model-provider-specific.
- Do not solve this through a larger monolithic prompt.
- Do not persist hidden chain-of-thought.
- Do not introduce a separate workflow database.
- Do not bypass existing TrueForge policy.
- Do not auto-approve sensitive operations.
- Do not retry ambiguous writes.
- Do not hand-edit generated SDK/OpenAPI output.
- Do not add unbounded subagent recursion.
- Do not expose all tools indiscriminately when adaptive selection is enabled.
- Do not claim benchmark improvement without paired results.
- Do not optimize only for the benchmark dataset.