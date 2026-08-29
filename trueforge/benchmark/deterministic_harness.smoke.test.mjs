/**
 * Smoke test for the deterministic no-network harness.
 *
 * Runs under Node's built-in test runner (`node --test`) with zero dependencies.
 * It imports the harness module directly and validates the machine-readable
 * report shape and invariants. It does NOT trigger a build itself — the harness
 * imports the already-built `packages/trueforge-core/dist/core/index.mjs`, so
 * `benchmark:deterministic` (which builds core once) must have run first, or the
 * dist must otherwise exist. This test never rebuilds recursively.
 *
 * It asserts:
 *   - the report parses and carries the expected schema id, environment metadata,
 *     and `unavailable_unverified` external-benchmark status;
 *   - every fixture reports a boolean pass and (for the offline run) passes;
 *   - the summary is internally consistent and the run is `ok`;
 *   - the latency fixture excludes tool latency and satisfies the < 100 ms gate;
 *   - the adaptive-stop fixture measured (not modeled) a >= 50% dispatch reduction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { distribution, externalModelBenchmark, percentile, runHarness } from './deterministic_harness.mjs';

test('harness produces a well-formed machine-readable report', async () => {
  const report = await runHarness();

  assert.equal(report.schema, 'adaptive-kernel.deterministic-harness/v1');
  assert.equal(typeof report.generated_at, 'string');

  // Environment metadata is present and points at the built dist.
  assert.equal(typeof report.environment.node_version, 'string');
  assert.equal(report.environment.network, 'none');
  assert.match(report.environment.core_dist, /trueforge-core\/dist\/core\/index\.mjs$/);

  // External model benchmark is explicitly unavailable/unverified, not fabricated.
  assert.equal(report.unverified.length, 1);
  assert.equal(report.unverified[0].status, 'unavailable_unverified');
  assert.equal(report.unverified[0].id, externalModelBenchmark.id);
});

test('every fixture passes and the summary is consistent and ok', async () => {
  const report = await runHarness();

  assert.ok(Array.isArray(report.fixtures));
  assert.ok(report.fixtures.length >= 9, `expected >= 9 fixtures, got ${report.fixtures.length}`);

  for (const fixture of report.fixtures) {
    assert.equal(typeof fixture.id, 'string');
    assert.equal(typeof fixture.pass, 'boolean');
    assert.equal(fixture.error, null, `fixture ${fixture.id} threw: ${fixture.error}`);
    assert.equal(fixture.pass, true, `fixture ${fixture.id} did not pass: ${fixture.detail}`);
  }

  const passed = report.fixtures.filter(f => f.pass).length;
  assert.equal(report.summary.total, report.fixtures.length);
  assert.equal(report.summary.passed, passed);
  assert.equal(report.summary.failed, report.fixtures.length - passed);
  assert.equal(report.summary.gated_failures, 0);
  assert.equal(report.summary.ok, true);
});

test('required scenarios are present as distinct fixtures', async () => {
  const report = await runHarness();
  const ids = new Set(report.fixtures.map(f => f.id));
  for (const required of [
    'latency_distributions',
    'blocked_before_dispatch',
    'typed_evidence_vs_prose',
    'parallel_safe_reads_overlap',
    'conflicting_writes_serialize',
    'denial_no_dispatch',
    'ambiguous_write_reconciliation',
    'persisted_restart_classification',
    'adaptive_stop_vs_naive',
  ]) {
    assert.ok(ids.has(required), `missing required fixture: ${required}`);
  }
});

test('latency fixture excludes tool latency and satisfies the < 100 ms gate', async () => {
  const report = await runHarness();
  const latency = report.fixtures.find(f => f.id === 'latency_distributions');
  assert.ok(latency, 'latency fixture missing');
  assert.equal(latency.measures.excludes_tool_latency, true);
  assert.equal(report.latency_gate_ms, 100);
  const coordinatorP95 = latency.measures.coordinator_distribution_ms.p95_ms;
  const overheadP95 = latency.measures.coordinator_overhead_ms.p95;
  assert.ok(coordinatorP95 < 100 || overheadP95 < 100, 'latency gate not satisfied');
});

test('adaptive-stop reduction is measured (not modeled) and >= 50%', async () => {
  const report = await runHarness();
  const adaptive = report.fixtures.find(f => f.id === 'adaptive_stop_vs_naive');
  assert.ok(adaptive, 'adaptive fixture missing');
  assert.equal(adaptive.measures.naive_is_measured_not_modeled, true);
  assert.equal(adaptive.measures.stop_level, 'stop');
  assert.ok(adaptive.measures.reduction_ratio >= 0.5, 'reduction below 50%');
  // The adaptive dispatched-call count equals the counted attempts (executed loop).
  assert.equal(adaptive.measures.adaptive_dispatched_calls, adaptive.measures.adaptive_executed_attempts);
});

test('exported statistics helpers are pure and deterministic', () => {
  const dist = distribution([3, 1, 2]);
  assert.equal(dist.samples, 3);
  assert.equal(dist.min_ms, 1);
  assert.equal(dist.max_ms, 3);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
});
