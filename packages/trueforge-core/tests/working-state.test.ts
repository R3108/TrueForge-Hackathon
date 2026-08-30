import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPersistableText,
  projectForModel,
  projectWorkingState,
  redactSummary,
  type WorkingStateEvent,
} from '../../../src/runtime/kernel/working-state.ts';

const events: WorkingStateEvent[] = [
  { type: 'phase_changed', phase: 'planning' },
  { type: 'plan_set', steps: [{ id: 's1', text: 'Reproduce the failure' }, { id: 's2', text: 'Write the fix' }] },
  { type: 'step_activated', id: 's1' },
  { type: 'fact_observed', text: 'The stack trace points at cart.js line 12', provenance: 'tool-discovered', verified: true },
  { type: 'approach_attempted', approach: 'Guarding the caller', outcome: 'failed' },
  { type: 'failure_recorded', failureClass: 'domain', summary: 'Null deref persists after guard' },
  { type: 'step_completed', id: 's1' },
  { type: 'step_activated', id: 's2' },
  { type: 'evidence_recorded', kind: 'targeted_test_pass', digest: 'abc', atEpoch: 1 },
  { type: 'criteria_set', criteria: ['fix passes', 'suite green'] },
  { type: 'criterion_satisfied', text: 'fix passes' },
];

describe('WorkingState projection', () => {
  test('replaying the same events reconstructs identical state', () => {
    const a = projectWorkingState('task', events);
    const b = projectWorkingState('task', events);
    // Ignore the wall-clock updatedAt; compare the durable fields.
    assert.deepEqual({ ...a, updatedAt: '' }, { ...b, updatedAt: '' });
  });

  test('active plan, blockers and remaining criteria survive projection', () => {
    const state = projectWorkingState('task', events);
    assert.deepEqual(state.activeStepIds, ['s2']);
    assert.equal(state.plan.find((s) => s.id === 's1')?.status, 'done');
    assert.deepEqual(state.remainingCriteria, ['suite green']);
    assert.equal(state.unresolvedErrors.filter((f) => !f.resolved).length, 1);
  });

  test('failed approaches survive and are projected as do-not-repeat guidance', () => {
    const state = projectWorkingState('task', events);
    const projection = projectForModel(state);
    assert.match(projection, /Do not repeat these failed approaches/);
    assert.match(projection, /Guarding the caller/);
  });

  test('facts retain provenance and harness-inference is never marked verified', () => {
    const state = projectWorkingState('task', [
      { type: 'fact_observed', text: 'This is probably a caching issue', provenance: 'harness-inferred', verified: true },
    ]);
    assert.equal(state.observedFacts[0]?.verified, false);
    assert.equal(state.observedFacts[0]?.provenance, 'harness-inferred');
  });
});

describe('WorkingState — no secrets or hidden reasoning', () => {
  test('rejects text that looks like a raw secret or reasoning trace', () => {
    assert.equal(isPersistableText('the api_key is sk-live-123'), false);
    assert.equal(isPersistableText('let me think about this step by step'), false);
    assert.equal(isPersistableText('The failing test is cart.test.js'), true);
  });

  test('secret-looking substrings are redacted in stored summaries', () => {
    const state = projectWorkingState('task', [
      { type: 'fact_observed', text: 'config uses token=deadbeef for auth', provenance: 'user', verified: false },
    ]);
    // The whole fact is rejected because it matches the secret hint,
    // demonstrating fail-closed persistence.
    assert.equal(state.observedFacts.length, 0);
    // redactSummary independently masks a secret token if it ever reaches storage.
    assert.match(redactSummary('token=deadbeef'), /token\[redacted\]/);
  });
});
