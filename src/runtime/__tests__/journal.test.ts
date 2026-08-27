import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Journal, verifyChain, type Decision, type JournalEntry } from '../journal.ts';

/**
 * The journal's only claim is that a decision record cannot be quietly edited
 * after the fact. These tests are that claim: they tamper with a chain the way
 * someone covering their tracks would, and check that it stops verifying.
 */

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  tool: 'create_or_update_file',
  threadId: 'main',
  toolCallId: 'call_1',
  paths: ['fixture/src/cart.js'],
  outcome: 'approved' as const,
  ...overrides,
});

/** In-memory: no `dir`, so no test ever touches the filesystem. */
const journal = () => new Journal({ sessionId: 'sess_1', incident: 'CART-4A2' });

describe('Journal', () => {
  test('numbers records in the order they were decided', () => {
    const log = journal();
    log.record(decision({ toolCallId: 'a' }));
    log.record(decision({ toolCallId: 'b', outcome: 'denied', reason: 'wrong file' }));

    assert.deepEqual(
      log.entries().map((entry) => [entry.seq, entry.toolCallId, entry.outcome]),
      [
        [1, 'a', 'approved'],
        [2, 'b', 'denied'],
      ],
    );
  });

  test('chains each record to the one before it', () => {
    const log = journal();
    const first = log.record(decision({ toolCallId: 'a' }));
    const second = log.record(decision({ toolCallId: 'b' }));

    assert.equal(first.prev, '', 'the first record chains from nothing');
    assert.equal(second.prev, first.hash);
    assert.equal(log.digest(), second.hash, 'the digest is the head of the chain');
  });

  test('gives two identical decisions different hashes', () => {
    const log = journal();
    const first = log.record(decision());
    const second = log.record(decision());

    assert.notEqual(first.hash, second.hash, 'position is part of what is being attested');
  });

  test('counts outcomes for the closing summary', () => {
    const log = journal();
    log.record(decision());
    log.record(decision({ outcome: 'denied' }));
    log.record(decision({ outcome: 'denied' }));

    assert.deepEqual(log.tally(), [
      ['approved', 1],
      ['denied', 2],
    ]);
  });

  test('an empty journal has a stable, empty digest', () => {
    assert.equal(journal().digest(), '');
    assert.deepEqual(journal().tally(), []);
  });

  test('writes nothing to disk when no directory is configured', () => {
    assert.equal(journal().file, undefined);
    assert.equal(journal().writeReport(), undefined);
  });
});

describe('verifyChain', () => {
  const chained = (): JournalEntry[] => {
    const log = journal();
    log.record(decision({ toolCallId: 'a' }));
    log.record(decision({ toolCallId: 'b', outcome: 'denied', reason: 'not that file' }));
    log.record(decision({ toolCallId: 'c', outcome: 'blocked-perimeter' }));
    return [...log.entries()];
  };

  test('accepts an untouched chain', () => {
    assert.deepEqual(verifyChain(chained()), { ok: true, entries: 3 });
  });

  test('accepts an empty chain', () => {
    assert.deepEqual(verifyChain([]), { ok: true, entries: 0 });
  });

  test('catches a record edited in place', () => {
    const entries = chained();
    // The interesting forgery: turn a denial into an approval after the fact.
    entries[1] = { ...entries[1]!, outcome: 'approved' };

    const result = verifyChain(entries);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.problem ?? '', /edited/);
  });

  test('catches a record removed from the middle', () => {
    const entries = chained();
    entries.splice(1, 1);

    const result = verifyChain(entries);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2, 'the gap shows up at the record that no longer chains');
    assert.match(result.problem ?? '', /removed|reordered/);
  });

  test('catches records swapped into a different order', () => {
    const entries = chained();
    const [first, second] = [entries[0]!, entries[1]!];
    entries[0] = second;
    entries[1] = first;

    assert.equal(verifyChain(entries).ok, false);
  });

  test('catches a truncated tail via the digest, not the chain', () => {
    const entries = chained();
    const digest = entries.at(-1)!.hash;
    entries.pop();

    assert.equal(verifyChain(entries).ok, true, 'a truncated chain is internally consistent');
    assert.notEqual(
      entries.at(-1)?.hash,
      digest,
      'which is why the run prints the digest: it is what a dropped tail contradicts',
    );
  });
});
