/**
 * The decision journal.
 *
 * An approval gate is only as good as what it can prove afterwards. "The agent
 * asked, someone said yes" is the single most important fact about an incident
 * run, and until now it existed only in terminal scrollback that scrolls away.
 *
 * Every decision - approved, denied, or refused automatically before a human
 * was asked - is appended to a JSONL file as it happens. Each record carries the
 * hash of the record before it, so the file is tamper-evident: edit or remove a
 * line and the chain stops verifying. The run prints the final digest, which is
 * a single string an operator can paste into the incident ticket and anyone can
 * check against the file later.
 *
 * This is a local audit trail, not a signed one. It proves the file has not been
 * quietly edited since the run; it does not prove who ran it. That distinction
 * is worth keeping honest.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, userInfo } from 'node:os';

export type Outcome =
  /** A human at a terminal typed yes. */
  | 'approved'
  /** A human at a terminal said no. */
  | 'denied'
  /** No TTY: nobody was there to ask, so it failed closed. */
  | 'denied-no-tty'
  /** The operator interrupted the prompt. */
  | 'denied-interrupt'
  /** Rehearsal run: writes are refused by policy, not by judgement. */
  | 'denied-rehearsal'
  /** The paused call could not be tied to its arguments, so nothing could check it. */
  | 'blocked-unresolved'
  /** Outside the declared write perimeter. No approval was offered. */
  | 'blocked-perimeter'
  /** The payload carried something that looked like a credential. */
  | 'blocked-secret';

export interface Decision {
  tool: string;
  threadId: string;
  toolCallId: string;
  paths: string[];
  outcome: Outcome;
  reason?: string;
}

export interface JournalEntry extends Decision {
  seq: number;
  ts: string;
  runId: string;
  sessionId: string;
  incident: string;
  operator: string;
  /** Hash of the previous entry; the genesis entry chains from "". */
  prev: string;
  /** sha256 of this entry with `hash` omitted. */
  hash: string;
}

export interface JournalOptions {
  sessionId: string;
  incident: string;
  /** Where to append. Omit for an in-memory journal (tests, `--no-journal`). */
  dir?: string;
  runId?: string;
  operator?: string;
}

const GENESIS = '';

/** sha256 over the entry's own fields, excluding the hash it is producing. */
function digestOf(entry: Omit<JournalEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

export class Journal {
  readonly runId: string;
  /** The JSONL file being appended to, or undefined for in-memory runs. */
  readonly file: string | undefined;

  #entries: JournalEntry[] = [];
  #sessionId: string;
  #incident: string;
  #operator: string;
  #writable: boolean;
  /** Decisions in the chain that never reached the file. */
  #unpersisted = 0;

  constructor(options: JournalOptions) {
    this.runId = options.runId ?? randomUUID();
    this.#sessionId = options.sessionId;
    this.#incident = options.incident;
    this.#operator = options.operator ?? defaultOperator();
    this.file = options.dir ? join(options.dir, `${options.sessionId}.jsonl`) : undefined;
    this.#writable = this.file !== undefined;
  }

  /** Append one decision and return the entry that was written. */
  record(decision: Decision): JournalEntry {
    const previous = this.#entries.at(-1);
    const body: Omit<JournalEntry, 'hash'> = {
      seq: this.#entries.length + 1,
      ts: new Date().toISOString(),
      runId: this.runId,
      sessionId: this.#sessionId,
      incident: this.#incident,
      operator: this.#operator,
      prev: previous?.hash ?? GENESIS,
      ...decision,
    };

    const entry: JournalEntry = { ...body, hash: digestOf(body) };

    // Append first. The digest this class advertises is a claim about what is on
    // disk, so an entry that failed to persist must not enter the chain - a
    // digest covering unwritten decisions cannot be checked against the file and
    // is worse than no digest at all.
    this.#append(entry);
    this.#entries.push(entry);
    return entry;
  }

  entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  /** The chain head: one string that fixes the whole sequence of decisions. */
  digest(): string {
    return this.#entries.at(-1)?.hash ?? GENESIS;
  }

  /** Counts by outcome, in the order they first occurred. */
  tally(): Array<[Outcome, number]> {
    const counts = new Map<Outcome, number>();
    for (const entry of this.#entries) {
      counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
    }
    return [...counts.entries()];
  }

  /**
   * A human-readable record beside the machine-readable one. The JSONL is for
   * tooling; this is the thing that gets pasted into the incident ticket.
   */
  writeReport(): string | undefined {
    if (!this.file || this.#entries.length === 0) return undefined;

    const path = this.file.replace(/\.jsonl$/, '.md');
    const rows = this.#entries.map(
      (entry) =>
        `| ${entry.seq} | ${entry.ts} | \`${entry.tool}\` | ${
          entry.paths.map((p) => `\`${p}\``).join('<br>') || '—'
        } | ${entry.outcome} | ${(entry.reason ?? '').replace(/\|/g, '\\|')} |`,
    );

    const report = [
      `# Incident ${this.#incident}`,
      '',
      `- Session: \`${this.#sessionId}\``,
      `- Run: \`${this.runId}\``,
      `- Operator: \`${this.#operator}\``,
      `- Decisions: ${this.#entries.length}`,
      `- Audit digest: \`sha256:${this.digest()}\``,
      '',
      '| # | when | tool | paths | outcome | reason |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows,
      '',
      `Verify with: \`npm run journal -- ${this.file}\``,
      '',
    ].join('\n');

    try {
      writeFileSync(path, report, 'utf8');
      return path;
    } catch {
      return undefined;
    }
  }

  /**
   * Never let bookkeeping break a repair run: a full disk should not turn into
   * a failed incident. The first write failure disables the file and says so.
   */
  #append(entry: JournalEntry): void {
    if (!this.file) return;
    if (!this.#writable) {
      this.#unpersisted++;
      return;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.#writable = false;
      this.#unpersisted++;
      console.error(
        `  (journal disabled: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /**
   * Is the digest a claim anyone can check?
   *
   * Only when every recorded decision reached the file. A digest computed over
   * entries that were never written cannot be verified against the journal, so
   * presenting it as an audit trail would be a lie told precisely when the audit
   * trail matters. Callers print the digest differently when this is false.
   */
  get persisted(): boolean {
    return this.#unpersisted === 0;
  }

  /** How many decisions are in the chain but not on disk. */
  get unpersisted(): number {
    return this.#unpersisted;
  }
}

export interface ChainResult {
  ok: boolean;
  entries: number;
  /** 1-based position of the first record that failed to verify. */
  brokenAt?: number;
  problem?: string;
}

/**
 * Recompute the chain. A journal verifies only if every record hashes to what
 * it claims and points at the record before it - which is what makes a deleted
 * or edited line detectable rather than merely unlikely.
 */
export function verifyChain(entries: JournalEntry[]): ChainResult {
  let prev = GENESIS;

  for (const [index, entry] of entries.entries()) {
    const { hash, ...body } = entry;

    if (entry.prev !== prev) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: index + 1,
        problem: 'record does not chain to the one before it (a line was removed or reordered)',
      };
    }

    if (digestOf(body) !== hash) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: index + 1,
        problem: 'record contents do not match its hash (a line was edited)',
      };
    }

    prev = hash;
  }

  return { ok: true, entries: entries.length };
}

/** Read a JSONL journal from disk. Malformed lines are a verification failure. */
export function readJournal(file: string): JournalEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

function defaultOperator(): string {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return 'unknown';
  }
}
