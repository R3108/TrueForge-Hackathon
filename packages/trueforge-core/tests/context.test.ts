import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblePrompt,
  budgetFitsWindow,
  debugPrompt,
  makeSection,
  orderSections,
  planContextBudget,
} from '../../../src/runtime/kernel/context.ts';

describe('Prompt assembly — ordering and precedence', () => {
  test('core policy is ordered before task, working state, and user input', () => {
    const sections = [
      makeSection('u', 'user-input', 'user says do X'),
      makeSection('ws', 'working-state', 'phase executing'),
      makeSection('policy', 'core-policy', 'never write outside perimeter'),
      makeSection('task', 'task-contract', 'objective: fix bug'),
    ];
    const ordered = orderSections(sections);
    const provs = ordered.map((s) => s.provenance);
    assert.deepEqual(provs, ['core-policy', 'task-contract', 'working-state', 'user-input']);
  });

  test('core sections are not overridable; user/task sections are', () => {
    assert.equal(makeSection('p', 'core-policy', 'x').overridable, false);
    assert.equal(makeSection('t', 'tool-guidance', 'x').overridable, true);
    assert.equal(makeSection('u', 'user-input', 'x').overridable, true);
  });

  test('duplicate section bodies are deduplicated, keeping highest precedence', () => {
    const ordered = orderSections([
      makeSection('a', 'user-input', 'Do not touch CI'),
      makeSection('b', 'core-policy', 'Do not touch CI'),
    ]);
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0]?.provenance, 'core-policy');
  });

  test('assembled prompt redacts secrets in redactable sections', () => {
    const prompt = assemblePrompt([
      makeSection('env', 'environment', 'token=deadbeef in config', { redact: true }),
    ]);
    assert.match(prompt, /token\[redacted\]/);
  });

  test('debug view is secret-free and reports token estimates', () => {
    const debug = debugPrompt([makeSection('task', 'task-contract', 'objective: fix')]);
    assert.equal(debug.sections.length, 1);
    assert.ok(debug.totalTokenEstimate > 0);
  });
});

describe('Context budget plan — deterministic and window-safe', () => {
  test('all category budgets fit inside the context window', () => {
    const plan = planContextBudget({ contextWindow: 128000, maxOutputTokens: 8192 }, 5000);
    assert.equal(budgetFitsWindow(plan), true);
    assert.ok(plan.pinnedBudget >= 0);
    assert.ok(plan.recentTailBudget > 0);
  });

  test('a model switch recalculates budgets from the new limits', () => {
    const small = planContextBudget({ contextWindow: 16000, maxOutputTokens: 2048 }, 5000);
    const large = planContextBudget({ contextWindow: 200000, maxOutputTokens: 8192 }, 5000);
    assert.notEqual(small.recentTailBudget, large.recentTailBudget);
    assert.ok(large.contextWindow > small.contextWindow);
    assert.equal(budgetFitsWindow(small), true);
    assert.equal(budgetFitsWindow(large), true);
  });

  test('pinned context cannot starve the recent tail', () => {
    const plan = planContextBudget({ contextWindow: 32000, maxOutputTokens: 4096 }, 1_000_000);
    assert.ok(plan.recentTailBudget > 0);
    assert.equal(budgetFitsWindow(plan), true);
  });
});
