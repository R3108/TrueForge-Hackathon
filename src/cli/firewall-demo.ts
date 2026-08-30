import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { ToolInvocation } from '../runtime/contracts.ts';
import { EvidenceLedger } from '../runtime/evidence.ts';
import { ToolCallGate } from '../runtime/gate.ts';
import { resolveRequiredAction, type StreamEvent } from '../runtime/protocol.ts';
import { renderApprovalCard } from '../runtime/approvals.ts';
import { banner, style } from '../runtime/render.ts';

const policy = {
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  writePaths: ['fixture/**'],
  githubConnector: 'github',
  githubConnectorId: 'github-id',
  policyVersion: 'demo-v1',
  requireTestEvidence: true,
};
const targetedCommand = 'npm test -- --test-name-pattern cart';
const fullSuiteCommand = 'npm test';
const evidence = new EvidenceLedger({
  targetedCommand,
  fullSuiteCommand,
  trustedExecutionTool: {
    toolSetId: 'trusted-host-id',
    toolSetName: 'trusted-host',
    toolType: 'truefoundry-system',
  },
});
const gate = new ToolCallGate(policy, evidence, Buffer.alloc(32, 42));

function invocation(
  toolName: string,
  args: unknown,
  toolCallId: string,
  threadId: string,
  toolSetId = 'github',
  turnId = 'demo-turn',
): ToolInvocation {
  const sandbox = toolSetId === 'sandbox';
  return {
    key: { sessionId: 'demo-session', turnId, threadId, toolCallId },
    sourceEventId: `event-${toolCallId}`,
    origin: sandbox ? 'sandbox' : 'agent',
    toolSetId: sandbox ? 'trusted-host-id' : `${toolSetId}-id`,
    toolSetName: sandbox ? 'trusted-host' : toolSetId,
    toolType: sandbox ? 'truefoundry-system' : 'mcp',
    toolName,
    arguments: args,
    policyVersion: policy.policyVersion,
    validationViolations: [],
  };
}

function line(ok: boolean, text: string): void {
  console.log(`  ${ok ? style.green('✓') : style.red('✗')} ${text}`);
  assert.ok(ok, text);
}

function executionFacts(status: 'succeeded' | 'failed', exitCode: number) {
  return { executionFacts: { version: 1 as const, status, exitCode, timedOut: false } };
}

banner('VERIFIED TOOL-CALL FIREWALL', 'deterministic offline scenario');

console.log(style.bold('\n1. Exact correlation across parallel calls'));
const source: StreamEvent = {
  type: 'model.message',
  id: 'message-parallel',
  threadId: 'main',
  toolCalls: [
    { id: 'call-A', function: { name: 'create_branch', arguments: '{}' } },
    { id: 'call-B', function: { name: 'create_pull_request', arguments: '{}' } },
  ],
};
const [second] = resolveRequiredAction(
  {
    type: 'tool.approval_required',
    id: 'approval-B',
    threadId: 'main',
    toolCalls: [{ id: 'call-B', sourceEventId: 'message-parallel' }],
  },
  new Map([['message-parallel', source]]),
  { sessionId: 'demo-session', turnId: 'demo-turn', policyVersion: policy.policyVersion },
);
line(second?.invocation.key.toolCallId === 'call-B', 'pause for call B resolves to call B, never call A');

console.log(style.bold('\n2. Enforced repository policy'));
const wrongRepo = gate.evaluate(
  invocation(
    'create_branch',
    { owner: 'attacker', repo: 'other', branch: 'fix/cart' },
    'wrong-repo',
    'policy',
  ),
);
line(
  wrongRepo.decision.type === 'deny' && wrongRepo.decision.code === 'repository_mismatch',
  'wrong-repository call is blocked before human approval',
);

console.log(style.bold('\n3. Bounded structured repair and fresh identity'));
const invalidArgs = {
  owner: 'truefoundry',
  repo: 'example',
  branch: 'fix/cart',
  content: 'export const fixed = true;',
};
const malformed = gate.evaluate(
  invocation('create_or_update_file', invalidArgs, 'malformed-1', 'repair'),
);
line(malformed.decision.type === 'repair', 'missing path produces structured repair feedback');
if (malformed.decision.type === 'repair') console.log(style.dim(`    ${malformed.decision.feedback}`));
const correctedCall = invocation(
  'create_or_update_file',
  { ...invalidArgs, path: 'fixture/src/cart.js' },
  'corrected-2',
  'repair',
  'github',
  'demo-turn-2',
);
const corrected = gate.evaluate(correctedCall);
line(
  corrected.decision.type === 'require_approval' && correctedCall.key.toolCallId !== 'malformed-1',
  'corrected semantics use a new call ID and require fresh approval',
);

console.log(style.bold('\n4. Structured, epoch-bound evidence'));
const regression = invocation(
  'sandbox_exec',
  { command: targetedCommand },
  'test-red',
  'evidence',
  'sandbox',
);
evidence.observeInvocation(regression);
evidence.observeResponse(regression.key, executionFacts('failed', 1));
const workspaceWrite = invocation(
  'write_file',
  { path: 'fixture/src/cart.js' },
  'sandbox-write',
  'evidence',
  'sandbox',
);
evidence.observeInvocation(workspaceWrite);
evidence.observeResponse(workspaceWrite.key, executionFacts('succeeded', 0));
for (const [id, command] of [
  ['test-green', targetedCommand],
  ['suite-green', fullSuiteCommand],
] as const) {
  const testCall = invocation('sandbox_exec', { command }, id, 'evidence', 'sandbox');
  evidence.observeInvocation(testCall);
  evidence.observeResponse(testCall.key, executionFacts('succeeded', 0));
}
const evidenceSummary = evidence.summary();
line(evidenceSummary.regressionObserved, 'regression failure was observed as a historical baseline');
line(evidenceSummary.targetedTestPassed, 'targeted test has a structured zero exit code at current epoch');
line(evidenceSummary.fullSuitePassed, 'full suite has a structured zero exit code at current epoch');

console.log(style.bold('\n5. Evidence-aware one-shot approval checkpoint'));
const pullRequest = invocation(
  'create_pull_request',
  {
    owner: 'truefoundry',
    repo: 'example',
    title: 'Fix cart regression',
    head: 'fix/cart',
    base: 'main',
    body: 'Regression reproduced; targeted and full suites passed.',
  },
  'pr-fresh-id',
  'publish',
);
const approval = gate.evaluate(pullRequest);
line(approval.decision.type === 'require_approval', 'publishing still pauses for explicit human approval');
renderApprovalCard(
  1,
  1,
  { kind: 'approval', actionId: 'approval-pr', invocation: pullRequest },
  approval,
);

console.log(style.bold('\n6. Circuit breaker'));
const repeatedArgs = { ...invalidArgs };
const firstRepeat = gate.evaluate(
  invocation('create_or_update_file', repeatedArgs, 'repeat-1', 'repeat'),
);
const secondRepeat = gate.evaluate(
  invocation('create_or_update_file', repeatedArgs, 'repeat-2', 'repeat', 'github', 'demo-turn-2'),
);
line(firstRepeat.decision.type === 'repair', 'first deterministic failure receives bounded feedback');
line(
  secondRepeat.decision.type === 'deny' && secondRepeat.decision.code === 'repeated_fingerprint',
  'second identical fingerprint stops; no unbounded retry loop',
);

const latencyGate = new ToolCallGate(policy, new EvidenceLedger(), Buffer.alloc(32, 24));
const gateLatenciesMs: number[] = [];
for (let index = 0; index < 200; index++) {
  const started = performance.now();
  latencyGate.evaluate(
    invocation(
      'create_branch',
      { owner: 'truefoundry', repo: 'example', branch: `fix/latency-${index}` },
      `latency-${index}`,
      `latency-${index}`,
    ),
  );
  gateLatenciesMs.push(performance.now() - started);
}
gateLatenciesMs.sort((a, b) => a - b);
const p95Index = Math.ceil(gateLatenciesMs.length * 0.95) - 1;
const p95GateLatencyMs = gateLatenciesMs[p95Index] ?? Number.POSITIVE_INFINITY;
line(p95GateLatencyMs < 100, `p95 local gate latency ${p95GateLatencyMs.toFixed(3)} ms (< 100 ms)`);

const counts = gate.attempts.reduce<Record<string, number>>((acc, attempt) => {
  acc[attempt.state] = (acc[attempt.state] ?? 0) + 1;
  return acc;
}, {});
console.log(style.bold('\nOffline metrics'));
console.log(`  gate attempts       ${gate.attempts.length}`);
console.log(`  repair requested    ${counts.repair_requested ?? 0}`);
console.log(`  blocked             ${counts.blocked ?? 0}`);
console.log(`  awaiting approval   ${counts.awaiting_approval ?? 0}`);
console.log(`  workspace epoch     ${evidence.workspaceEpoch}`);
console.log(style.green('\nDeterministic firewall demo passed. No external services were used.\n'));
