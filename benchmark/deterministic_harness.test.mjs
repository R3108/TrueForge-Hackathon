import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fixtures,
  runFixture,
  runHarness,
  buildReport,
  distribution,
  percentile,
  externalModelBenchmark,
} from './deterministic_harness.mjs';

/**
 * Deterministic smoke test for the harness result schema and run command.
 * It runs the real fixtures against the real runtime classes (no network),
 * asserts the machine-readable shape, and asserts the required paired fixtures
 * are present and passing. This is the unit-level guarantee that the harness
 * itself is well-formed before it is trusted as a gate.
 */

const REQUIRED_FIXTURE_IDS = [
  'latency_overhead',
  'blocked_before_dispatch',
  'typed_evidence_vs_prose',
  'safe_parallel_reads',
  'conflicting_writes_serialization',
  'denial_no_dispatch',
  'ambiguous_write_disposition',
  'restart_classification',
  'adaptive_stop_reduction',
  'simple_question_bypass',
  'contract_extraction',
  'replayed_working_state',
  'false_completion_blocking',
  'stale_evidence',
  'context_planning_injection',
  'model_switch_budget',
  'active_work_compaction',
  'tool_selection',
  'delegation_ownership_depth',
  'contract_revision_history',
];

describe('deterministic harness — statistics helpers', () => {
  test('percentile is monotonic and bounds-safe', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(sorted, 0.5), 5);
    assert.equal(percentile(sorted, 0.95), 10);
    assert.equal(percentile([], 0.5), Number.POSITIVE_INFINITY);
  });

  test('distribution reports the expected ordered fields', () => {
    const dist = distribution([3, 1, 2]);
    assert.equal(dist.samples, 3);
    assert.equal(dist.min_ms, 1);
    assert.equal(dist.max_ms, 3);
    assert.ok(dist.p50_ms >= dist.min_ms && dist.p95_ms <= dist.max_ms);
  });
});

describe('deterministic harness — report schema', () => {
  const report = runHarness();

  test('top-level schema shape is stable and machine-readable', () => {
    assert.equal(report.schema, 'ltp.deterministic-harness/v1');
    assert.equal(typeof report.generated_at, 'string');
    assert.equal(typeof report.latency_gate_ms, 'number');
    assert.ok(Array.isArray(report.fixtures));
    assert.ok(Array.isArray(report.unverified));
    for (const key of ['total', 'passed', 'failed', 'gated_failures', 'ok']) {
      assert.ok(key in report.summary, `summary.${key} present`);
    }
  });

  test('environment metadata is captured', () => {
    for (const key of ['node_version', 'platform', 'arch', 'cpu_model', 'cpu_count', 'network']) {
      assert.ok(key in report.environment, `environment.${key} present`);
    }
    assert.equal(report.environment.network, 'none');
  });

  test('every required paired fixture is present, gated, and passing', () => {
    const byId = new Map(report.fixtures.map((f) => [f.id, f]));
    for (const id of REQUIRED_FIXTURE_IDS) {
      const fixture = byId.get(id);
      assert.ok(fixture, `fixture ${id} present`);
      assert.equal(fixture.gate, true, `fixture ${id} is a gate`);
      assert.equal(fixture.pass, true, `fixture ${id} passes`);
      assert.equal(typeof fixture.measures, 'object');
      assert.equal(fixture.error, null, `fixture ${id} did not throw`);
    }
    assert.equal(report.fixtures.length, REQUIRED_FIXTURE_IDS.length);
  });

  test('summary agrees with fixture pass/fail counts and ok flag', () => {
    const passed = report.fixtures.filter((f) => f.pass).length;
    const gatedFailures = report.fixtures.filter((f) => f.gate && !f.pass).length;
    assert.equal(report.summary.passed, passed);
    assert.equal(report.summary.total, report.fixtures.length);
    assert.equal(report.summary.gated_failures, gatedFailures);
    assert.equal(report.summary.ok, gatedFailures === 0);
    assert.equal(report.summary.ok, true);
  });
});

describe('deterministic harness — measured invariants', () => {
  const report = runHarness();
  const byId = new Map(report.fixtures.map((f) => [f.id, f]));

  test('latency: coordinator p95 is under the 100 ms gate and overhead excludes tool latency', () => {
    const m = byId.get('latency_overhead').measures;
    assert.equal(m.excludes_tool_latency, true);
    assert.ok(m.coordinator_distribution_ms.samples >= 2000, 'enough samples');
    assert.ok(m.warmup_iterations >= 1, 'warmup performed');
    assert.ok(m.coordinator_distribution_ms.p95_ms < 100, 'coordinator p95 < 100 ms');
    assert.equal(m.p95_gate_pass, true);
    assert.equal(typeof m.coordinator_overhead_ms.p50, 'number');
    assert.equal(typeof m.coordinator_overhead_ms.p95, 'number');
  });

  test('blocked-before-dispatch: nothing dispatched, malformed JSON detected', () => {
    const m = byId.get('blocked_before_dispatch').measures;
    assert.equal(m.parsed_json_violation, 'invalid_json');
    assert.equal(m.dispatched_count, 0);
    assert.equal(m.blocked_count, m.cases.length);
    assert.ok(m.cases.every((c) => c.dispatched === false));
  });

  test('typed evidence beats prose: typed records exist, prose yields zero typed records', () => {
    const m = byId.get('typed_evidence_vs_prose').measures;
    assert.ok(m.typed.observed_record_count >= 2);
    assert.equal(m.prose.typed_record_count, 0);
    assert.equal(m.prose.unverified_success_observed, true);
    assert.equal(m.prose.targeted_passed, false);
  });

  test('adaptive stop achieves >= 50% reduction versus naive repeated calls', () => {
    const m = byId.get('adaptive_stop_reduction').measures;
    assert.ok(m.reduction_ratio >= m.reduction_gate);
    assert.ok(m.coordinator_attempts < m.naive_repeated_attempts);
  });

  test('external model benchmark is reported unverified, never fabricated', () => {
    assert.equal(externalModelBenchmark.status, 'unavailable_unverified');
    assert.equal(report.unverified[0].status, 'unavailable_unverified');
  });
});

describe('deterministic harness — kernel-backed invariants', () => {
  const report = runHarness();
  const byId = new Map(report.fixtures.map((f) => [f.id, f]));

  test('simple-question bypass carries no action machinery; action briefs are not bypassed', () => {
    const m = byId.get('simple_question_bypass').measures;
    assert.equal(m.question.task_type, 'question');
    assert.equal(m.question.bypassed, true);
    assert.equal(m.question.required_evidence, 0);
    assert.equal(m.question.acceptance_criteria, 0);
    assert.equal(m.action_brief.bypassed, false);
  });

  test('contract extraction keeps user/policy/inferred provenance separate; no untrusted promotion', () => {
    const m = byId.get('contract_extraction').measures;
    assert.equal(m.task_type, 'bug_fix');
    assert.equal(m.user_prohibition_preserved, true);
    assert.ok(m.policy_constraint_count >= 2);
    assert.ok(m.harness_inferred_criteria >= 1);
    assert.equal(m.has_regression_evidence, true);
    assert.equal(m.has_human_approval_evidence, true);
    assert.equal(m.untrusted_promoted_to_user, false);
  });

  test('working state replays to an identical projection with deterministic ids', () => {
    const m = byId.get('replayed_working_state').measures;
    assert.equal(m.identical_projection, true);
    assert.ok(m.observed_facts >= 1);
    assert.ok(m.unresolved_errors >= 1);
    assert.equal(typeof m.deterministic_fact_id, 'string');
  });

  test('false completion is blocked and rewritten; genuine completion passes', () => {
    const m = byId.get('false_completion_blocking').measures;
    assert.equal(m.blocked.satisfied, false);
    assert.equal(m.blocked.false_completion_blocked, true);
    assert.equal(m.blocked.rewritten_incomplete, true);
    assert.ok(m.blocked.blocking_reason_count > 0);
    assert.equal(m.genuine.satisfied, true);
  });

  test('stale evidence (historical epoch / advanced policy) fails completion', () => {
    const m = byId.get('stale_evidence').measures;
    assert.equal(m.historical_regression.satisfied, false);
    assert.equal(m.historical_regression.any_stale, true);
    assert.equal(m.policy_advanced.satisfied, false);
    assert.equal(m.policy_advanced.policy_verifier_stale, true);
  });

  test('context budget fits the window and core policy outranks injected input', () => {
    const m = byId.get('context_planning_injection').measures;
    assert.equal(m.budget_fits_window, true);
    assert.ok(m.pinned_budget > 0);
    assert.equal(m.core_section_first, true);
    assert.equal(m.injection_section_last, true);
    assert.equal(m.core_non_overridable, true);
    assert.equal(m.core_precedes_injection_in_prompt, true);
  });

  test('a model switch recomputes budgets: smaller window yields smaller budgets', () => {
    const m = byId.get('model_switch_budget').measures;
    assert.equal(m.large.fits, true);
    assert.equal(m.small.fits, true);
    assert.ok(m.small.context_window < m.large.context_window);
    assert.ok(m.small.recent_tail_budget < m.large.recent_tail_budget);
  });

  test('compaction projection preserves unresolved work and drops satisfied criteria', () => {
    const m = byId.get('active_work_compaction').measures;
    assert.equal(m.preserves_failed_approaches, true);
    assert.equal(m.preserves_unresolved_errors, true);
    assert.equal(m.preserves_remaining_criteria, true);
    assert.equal(m.satisfied_criterion_dropped, true);
  });

  test('tool selection hides irrelevant tools while preserving required routes', () => {
    const m = byId.get('tool_selection').measures;
    assert.equal(m.fell_back_to_full, false);
    assert.ok(m.tools_presented < m.tools_available);
    assert.equal(m.write_tool_presented, true);
    assert.equal(m.discovery_route_preserved, true);
    assert.equal(m.preloaded_preserved, true);
    assert.equal(m.irrelevant_read_hidden, true);
  });

  test('delegation is least-privilege: no widening, no depth escape, no resource theft', () => {
    const m = byId.get('delegation_ownership_depth').measures;
    assert.deepEqual(m.valid_delegation.allowed, ['read']);
    assert.equal(m.valid_delegation.depth, 1);
    assert.equal(m.widening_denied, 'permission_widening');
    assert.equal(m.depth_denied, 'depth_exceeded');
    assert.equal(m.resource_conflict_denied, 'resource_conflict');
    assert.equal(m.escaped_write_rejected, true);
  });

  test('a user correction creates a new revision without mutating history', () => {
    const m = byId.get('contract_revision_history').measures;
    assert.equal(m.original_revision, 1);
    assert.equal(m.revised_revision, 2);
    assert.equal(m.same_task_id, true);
    assert.equal(m.correction_in_revised, true);
    assert.equal(m.original_unmutated, true);
  });
});

describe('deterministic harness — runner robustness', () => {
  test('runFixture captures a thrown fixture as a gated failure without crashing', () => {
    const outcome = runFixture(function throwingFixture() {
      throw new Error('boom');
    });
    assert.equal(outcome.pass, false);
    assert.equal(outcome.gate, true);
    assert.match(outcome.error, /boom/);
  });

  test('buildReport marks the run not-ok when a gated fixture fails', () => {
    const report = buildReport([
      { id: 'x', title: 'x', gate: true, pass: false, detail: '', duration_ms: 0, error: null, measures: {} },
    ]);
    assert.equal(report.summary.ok, false);
    assert.equal(report.summary.gated_failures, 1);
  });

  test('the registered fixture set matches the required paired fixtures', () => {
    const ids = fixtures.map((fn) => runFixture(fn).id);
    for (const id of REQUIRED_FIXTURE_IDS) {
      assert.ok(ids.includes(id), `registered fixture ${id}`);
    }
  });
});
