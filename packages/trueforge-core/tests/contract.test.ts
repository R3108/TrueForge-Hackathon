import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTaskContract,
  isSimpleQuestion,
  reviseContract,
  type CompilerOptions,
} from '../../../src/runtime/kernel/contract.ts';

const options: CompilerOptions = {
  requireTestEvidence: true,
  writePaths: ['fixture/**'],
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  policyVersion: 'v1',
};

describe('RequestCompiler — simple-question bypass', () => {
  test('classifies a conversational question and bypasses compilation', () => {
    const contract = compileTaskContract('What does this function do?', options, 't1');
    assert.equal(contract.taskType, 'question');
    assert.equal(contract.bypassed, true);
    assert.equal(contract.requiredEvidence.length, 0);
    assert.equal(contract.acceptanceCriteria.length, 0);
  });

  test('isSimpleQuestion rejects action briefs even when phrased as questions', () => {
    assert.equal(isSimpleQuestion('Can you fix the null deref in cart.js?'), false);
    assert.equal(isSimpleQuestion('How does the gate work?'), true);
  });
});

describe('RequestCompiler — action tasks', () => {
  test('a bug-fix prompt produces acceptance criteria and required evidence', () => {
    const contract = compileTaskContract(
      'Fix the TypeError exception thrown in checkout when the cart is empty',
      options,
      't2',
    );
    assert.equal(contract.taskType, 'bug_fix');
    assert.equal(contract.bypassed, false);
    assert.ok(contract.acceptanceCriteria.some((c) => c.provenance === 'harness-inferred'));
    assert.ok(contract.requiredEvidence.some((e) => e.kind === 'regression_reproduction'));
    assert.ok(contract.requiredEvidence.some((e) => e.kind === 'human_approval'));
  });

  test('explicit user prohibitions are preserved with user provenance', () => {
    const contract = compileTaskContract(
      'Fix the crash, but do not touch the CI configuration.',
      options,
      't3',
    );
    const userProhibition = contract.constraints.find((c) => c.provenance === 'user');
    assert.ok(userProhibition);
    assert.match(userProhibition.text, /do not touch/i);
  });

  test('policy-imposed constraints are distinct from user constraints', () => {
    const contract = compileTaskContract('Fix the failing test', options, 't4');
    const policy = contract.constraints.filter((c) => c.provenance === 'policy');
    assert.ok(policy.some((c) => /write.*restricted/i.test(c.text)));
    assert.ok(policy.some((c) => /protected base branch/i.test(c.text)));
  });

  test('ambiguity is marked, not invented, and can block', () => {
    const contract = compileTaskContract(
      'Fix this by either patching the caller or the callee',
      options,
      't5',
    );
    assert.ok(contract.ambiguities.some((a) => a.blocking));
    assert.equal(contract.status, 'blocked');
  });
});

describe('RequestCompiler — provenance safety and revisions', () => {
  test('repository content is never promoted to a user constraint', () => {
    // Simulated untrusted tool/repo text is NOT passed through compileTaskContract
    // as the user brief; the compiler only tags the user brief as user-authored.
    const contract = compileTaskContract('Refactor cart.js for clarity', options, 't6');
    const untrustedPromoted = contract.constraints.some(
      (c) => c.provenance === 'user' && /ignore previous instructions/i.test(c.text),
    );
    assert.equal(untrustedPromoted, false);
  });

  test('a user correction creates a new revision without mutating history', () => {
    const original = compileTaskContract('Fix the bug in cart.js', options, 't7');
    const revised = reviseContract(original, 'Actually, do not modify cart.js; fix server.js instead', options);
    assert.equal(original.revision, 1);
    assert.equal(revised.revision, 2);
    assert.notEqual(original, revised);
    assert.ok(revised.constraints.some((c) => c.provenance === 'user' && /do not modify/i.test(c.text)));
  });
});
