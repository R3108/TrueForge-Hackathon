import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stdin } from 'node:process';

import { requestClearance, requestResponses } from '../approvals.ts';
import type { PendingApproval, PendingResponse, ToolInvocation } from '../contracts.ts';
import { EvidenceLedger } from '../evidence.ts';
import { ToolCallGate, type FirewallPolicy } from '../gate.ts';
import { Journal } from '../journal.ts';

/**
 * The safety claim of this project is that the agent cannot write to a
 * repository while nobody is watching - and that what a human *is* shown is the
 * exact call the decision binds to. These tests hold both claims to account.
 */

const policy: FirewallPolicy = {
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  writePaths: ['src/**', '!.github/**'],
  githubConnector: 'github',
  githubConnectorId: 'github-id',
  policyVersion: 'test-v1',
  requireTestEvidence: false,
};

function gate(): ToolCallGate {
  return new ToolCallGate(policy, new EvidenceLedger(), Buffer.alloc(32, 7));
}

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    key: {
      sessionId: 'session_1',
      turnId: 'turn_1',
      threadId: 'main',
      toolCallId: 'call_1',
    },
    sourceEventId: 'event_1',
    origin: 'agent',
    toolSetId: 'github-id',
    toolSetName: 'github',
    toolType: 'mcp',
    toolName: 'create_pull_request',
    arguments: {
      owner: 'truefoundry',
      repo: 'example',
      title: 'Fix null deref in cart.js',
      head: 'fix/cart',
      base: 'main',
    },
    policyVersion: 'test-v1',
    validationViolations: [],
    ...overrides,
  };
}

function approval(overrides: Partial<ToolInvocation> = {}): PendingApproval {
  return { kind: 'approval', actionId: 'action_1', invocation: invocation(overrides) };
}

const reasonOf = (decision: { approval?: unknown } | undefined): string =>
  ((decision?.approval as { reason?: string })?.reason ?? '');

/** In-memory journal: no `dir`, so nothing is written to disk. */
const journal = (): Journal => new Journal({ sessionId: 'test', incident: 'TEST-1' });

describe('required action handling', () => {
  let originalIsTTY: boolean | undefined;

  before(() => {
    originalIsTTY = stdin.isTTY;
  });

  after(() => {
    // `isTTY` is absent (not false) on a real non-TTY stream, so restore shape.
    if (originalIsTTY === undefined) delete (stdin as { isTTY?: boolean }).isTTY;
    else stdin.isTTY = originalIsTTY;
  });

  test('returns no decisions when nothing is pending', async () => {
    assert.deepEqual(await requestClearance([], gate()), []);
  });

  test('denies every reviewable write when there is no interactive terminal', async () => {
    stdin.isTTY = false;
    const decisions = await requestClearance(
      [
        approval(),
        approval({ key: { ...invocation().key, toolCallId: 'call_b', threadId: 'sub_7f2a' } }),
      ],
      gate(),
    );

    assert.equal(decisions.length, 2);
    assert.deepEqual(
      decisions.map((decision) => [decision.toolCallId, decision.threadId, decision.approval.status]),
      [
        ['call_1', 'main', 'deny'],
        ['call_b', 'sub_7f2a', 'deny'],
      ],
    );
  });

  test('gives the agent a reason when it denies, so it can explain itself', async () => {
    stdin.isTTY = false;

    const [decision] = await requestClearance([approval()], gate());
    assert.ok(decision, 'expected a decision');
    assert.equal(decision.approval.status, 'deny');
    assert.match(
      reasonOf(decision),
      /non-interactive/i,
      'the denial reason should tell the agent why it was refused',
    );
  });

  test('blocks a write outside the perimeter before asking a human', async () => {
    stdin.isTTY = true;
    const decisions = await requestClearance(
      [
        approval({
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: '.github/workflows/ci.yml',
            content: 'on: push',
          },
        }),
      ],
      gate(),
    );

    assert.equal(decisions[0]?.approval.status, 'deny');
    assert.match(reasonOf(decisions[0]), /perimeter/i);
  });

  test('names the exclusion when one refused the write', async () => {
    stdin.isTTY = true;

    const decisions = await requestClearance(
      [
        approval({
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: '.github/workflows/ci.yml',
            content: 'on: push',
          },
        }),
      ],
      gate(),
    );

    assert.match(reasonOf(decisions[0]), /excluded by !\.github/);
  });

  test('does not let a perimeter breach ride along with a legitimate write', async () => {
    stdin.isTTY = false;

    const decisions = await requestClearance(
      [
        approval({
          key: { ...invocation().key, toolCallId: 'inside' },
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: 'src/cart.js',
            content: '// fix',
          },
        }),
        approval({
          key: { ...invocation().key, toolCallId: 'outside' },
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: '.github/workflows/ci.yml',
            content: 'on: push',
          },
        }),
      ],
      gate(),
    );

    assert.equal(decisions.length, 2, 'every call must still be answered');
    for (const decision of decisions) {
      assert.equal(decision.approval.status, 'deny');
    }
  });

  test('answers each pending call with its own id, not a shared one', async () => {
    stdin.isTTY = false;

    const decisions = await requestClearance(
      [
        approval({ key: { ...invocation().key, toolCallId: 'call_a' } }),
        approval({
          key: { ...invocation().key, toolCallId: 'call_b', threadId: 'sub_7f2a' },
        }),
      ],
      gate(),
    );

    assert.deepEqual(
      decisions.map((d) => [d.toolCallId, d.threadId]),
      [
        ['call_a', 'main'],
        ['call_b', 'sub_7f2a'],
      ],
      'a decision routed to the wrong call would approve something unreviewed',
    );
  });

  test('refuses a payload carrying a credential without asking a human', async () => {
    stdin.isTTY = true;

    // Assembled at runtime so this file never contains a token-shaped literal
    // for a secret scanner - ours or GitHub's - to trip over.
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'kLmNoPqRsTuVwXyZ0123'}`;

    const decisions = await requestClearance(
      [
        approval({
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: 'src/client.js',
            content: `const auth = "${token}";`,
          },
        }),
      ],
      gate(),
    );

    assert.equal(decisions[0]?.approval.status, 'deny');
    assert.match(reasonOf(decisions[0]), /tripwire/i);
    assert.doesNotMatch(reasonOf(decisions[0]), new RegExp(token), 'never echo the secret back');
  });

  test('a human_review call cannot bypass the tripwire with a secret in its payload', async () => {
    stdin.isTTY = true;

    // create_pull_request with requireTestEvidence and no evidence is exactly
    // what routes the gate to human_review - the path that used to skip the
    // scan. The secret rides in the PR body, which is persisted in the repo.
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'kLmNoPqRsTuVwXyZ0123'}`;
    const reviewGate = new ToolCallGate(
      { ...policy, requireTestEvidence: true },
      new EvidenceLedger(),
      Buffer.alloc(32, 7),
    );

    const decisions = await requestClearance(
      [
        approval({
          toolName: 'create_pull_request',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            title: 'Fix null deref',
            head: 'fix/cart',
            base: 'main',
            body: `Works on my machine. Token: ${token}`,
          },
        }),
      ],
      reviewGate,
    );

    assert.equal(decisions[0]?.approval.status, 'deny');
    assert.match(reasonOf(decisions[0]), /tripwire/i);
    assert.doesNotMatch(reasonOf(decisions[0]), new RegExp(token), 'never echo the secret back');
  });

  test('lets a credential through to the human when the policy says warn', async () => {
    stdin.isTTY = false; // denied for lack of a TTY, not by the tripwire

    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'kLmNoPqRsTuVwXyZ0123'}`;
    const decisions = await requestClearance(
      [
        approval({
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: 'src/a.js',
            content: token,
          },
        }),
      ],
      gate(),
      { secretPolicy: 'warn' },
    );

    assert.match(reasonOf(decisions[0]), /non-interactive/i);
  });

  test('a rehearsal refuses every write even with a human at the terminal', async () => {
    stdin.isTTY = true;

    const decisions = await requestClearance([approval()], gate(), { rehearse: true });

    assert.equal(decisions[0]?.approval.status, 'deny');
    assert.match(reasonOf(decisions[0]), /rehearsal/i);
  });

  test('journals every automatic refusal, with the paths it refused', async () => {
    stdin.isTTY = false;
    const log = journal();

    await requestClearance(
      [
        approval({
          key: { ...invocation().key, toolCallId: 'a' },
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: '.github/workflows/ci.yml',
            content: 'on: push',
          },
        }),
        approval({
          key: { ...invocation().key, toolCallId: 'b' },
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: 'src/cart.js',
            content: '// fix',
          },
        }),
      ],
      gate(),
      { journal: log },
    );

    assert.deepEqual(
      log.entries().map((entry) => [entry.toolCallId, entry.outcome, entry.paths]),
      [
        ['a', 'blocked-perimeter', ['.github/workflows/ci.yml']],
        ['b', 'denied-no-tty', ['src/cart.js']],
      ],
      'the record has to distinguish "nobody was asked" from "nobody was there"',
    );
  });

  test('uses user.tool_response for response-required actions', async () => {
    stdin.isTTY = false;
    const pending: PendingResponse = {
      kind: 'response',
      actionId: 'response_1',
      invocation: invocation({ origin: 'client', toolName: 'ask_user' }),
    };

    const [decision] = await requestResponses([pending]);
    assert.equal(decision?.type, 'user.tool_response');
    assert.equal(decision?.toolCallId, 'call_1');
    assert.match(decision?.content ?? '', /human_response_unavailable/);
  });
});
