import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDelegation,
  validateChildResult,
  type ChildResult,
  type DelegationRequest,
  type ParentAuthority,
} from '../../../src/runtime/kernel/delegation.ts';

function parent(over: Partial<ParentAuthority> = {}): ParentAuthority {
  return {
    parentTaskId: 'p1',
    allowedToolCapabilities: ['read', 'search', 'test'],
    ownedResources: ['fixture/src/cart.js'],
    depth: 0,
    maxDepth: 2,
    profileToolCapabilities: ['read', 'search', 'test', 'write'],
    ...over,
  };
}

function request(over: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    objective: 'Read the failing call site',
    constraints: [],
    expectedOutput: [{ id: 'o1', description: 'summary of the call site' }],
    requestedToolCapabilities: ['read', 'search'],
    deniedToolCapabilities: [],
    resourceOwnership: [],
    evidenceRequirements: [],
    maxSteps: 8,
    ...over,
  };
}

describe('DelegationContract — least privilege', () => {
  test('capabilities are the intersection of parent, profile, and request minus denials', () => {
    const outcome = deriveDelegation(
      parent(),
      request({ requestedToolCapabilities: ['read', 'search', 'test'], deniedToolCapabilities: ['test'] }),
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.contract.allowedToolCapabilities.sort(), ['read', 'search']);
      assert.equal(outcome.contract.depth, 1);
    }
  });

  test('a child can never widen parent authority', () => {
    const outcome = deriveDelegation(parent(), request({ requestedToolCapabilities: ['read', 'write'] }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, 'permission_widening');
  });

  test('depth ceiling is enforced', () => {
    const outcome = deriveDelegation(parent({ depth: 2, maxDepth: 2 }), request());
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, 'depth_exceeded');
  });

  test('owning a parent/sibling write resource is a conflict unless explicitly allowed', () => {
    const conflicting = request({
      requestedToolCapabilities: ['read'],
      resourceOwnership: ['fixture/src/cart.js'],
    });
    const denied = deriveDelegation(parent(), conflicting);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, 'resource_conflict');

    const allowed = deriveDelegation(parent(), conflicting, { allowSharedResources: true });
    assert.equal(allowed.ok, true);
  });
});

describe('DelegationContract — structured child results', () => {
  test('a child result is validated and may only report owned resource changes', () => {
    const outcome = deriveDelegation(
      parent({ ownedResources: [] }),
      request({ requestedToolCapabilities: ['read', 'write'].filter((c) => c === 'read'), resourceOwnership: ['fixture/src/new.js'] }),
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const good: ChildResult = {
      delegationId: outcome.contract.delegationId,
      status: 'succeeded',
      resultSummary: 'wrote new.js',
      claims: ['added helper'],
      evidenceReferences: ['ev-1'],
      resourcesInspected: ['fixture/src/cart.js'],
      resourcesChanged: ['fixture/src/new.js'],
      unresolvedQuestions: [],
      recommendedNextAction: 'run the suite',
    };
    assert.deepEqual(validateChildResult(outcome.contract, good), { ok: true });

    const escaped: ChildResult = { ...good, resourcesChanged: ['fixture/src/other.js'] };
    const verdict = validateChildResult(outcome.contract, escaped);
    assert.equal(verdict.ok, false);
  });
});
