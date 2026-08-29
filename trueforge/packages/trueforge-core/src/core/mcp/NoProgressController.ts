import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fingerprintArguments } from './canonicalArguments';

/**
 * Restart-safe no-progress enforcement.
 *
 * The controller watches each completed ordinary model tool batch and detects a loop where the agent
 * keeps taking the same action and getting the same outcome without making progress. It owns only
 * bounded hashes — never raw arguments, results, or failures — so its durable state carries no
 * evidence and survives a restart through the existing `capability_state` snapshot/event store under
 * the reserved key {@link NO_PROGRESS_STATE_KEY}.
 *
 * Progress model (per observed batch):
 *  - The *action signature* is a stable, order-independent hash over every call in the batch, each
 *    call keyed by stable tool-set id, original tool name, and the shared canonical argument
 *    fingerprint. Tool-call ids and batch ordering never enter the hash.
 *  - The *outcome signature* hashes the normalized result content / failure of the batch, again with
 *    no raw payload retained.
 *  - The *first* failing batch counts as one no-progress step. Every *subsequent* non-progress batch
 *    increments the same budget: a different failed alternative, an exact repeat, and a cosmetic
 *    variant all increment (rotating arguments or tools while still failing is not progress and must
 *    not evade the budget).
 *  - An exact/cosmetic-equivalent action producing the same outcome increments the counter.
 *  - A new successful action, or a changed successful outcome, is progress: it — and only it — resets
 *    the counter and starts a new progress epoch.
 *
 * Thresholds are strictly ordered `reminder < replan < stop`. At `reminder`/`replan` the caller
 * injects ephemeral tfy-internal guidance before the next LLM call; at `stop` the caller terminates
 * before another LLM/tool dispatch. The controller itself never dispatches, throws, or mutates the
 * call batch.
 */

/** Reserved durable capability-state key. Owned by the fixed-core controller, never a user capability. */
export const NO_PROGRESS_STATE_KEY = 'tfy.no_progress';

const STATE_VERSION = 1;

export const DEFAULT_NO_PROGRESS_CONFIG = Object.freeze({
  reminder_threshold: 2,
  replan_threshold: 3,
  stop_threshold: 5,
  history_limit: 16,
});

/**
 * Validated configuration. Thresholds must be strictly ordered `reminder < replan < stop`; the
 * refinement rejects any other ordering rather than silently reordering. `enabled: false` turns the
 * controller off entirely (safe defaults otherwise apply).
 */
export const NoProgressConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    reminder_threshold: z.number().int().min(1).max(1_000).default(DEFAULT_NO_PROGRESS_CONFIG.reminder_threshold),
    replan_threshold: z.number().int().min(1).max(1_000).default(DEFAULT_NO_PROGRESS_CONFIG.replan_threshold),
    stop_threshold: z.number().int().min(1).max(1_000).default(DEFAULT_NO_PROGRESS_CONFIG.stop_threshold),
    history_limit: z.number().int().min(1).max(256).default(DEFAULT_NO_PROGRESS_CONFIG.history_limit),
  })
  .strict()
  .refine(c => c.reminder_threshold < c.replan_threshold && c.replan_threshold < c.stop_threshold, {
    message: 'no-progress thresholds must be strictly ordered: reminder < replan < stop',
    path: ['reminder_threshold'],
  });

export type NoProgressConfig = z.infer<typeof NoProgressConfigSchema>;

/**
 * Per-agent override surface exposed through `AgentDefinition`. `false` disables the controller; an
 * object supplies a partial threshold/limit override that is validated and merged onto safe defaults.
 * `undefined`/`true` keep the fixed-core default-on behavior.
 */
export const NoProgressOverrideSchema = z.union([
  z.boolean(),
  z
    .object({
      reminder_threshold: z.number().int().min(1).max(1_000).optional(),
      replan_threshold: z.number().int().min(1).max(1_000).optional(),
      stop_threshold: z.number().int().min(1).max(1_000).optional(),
      history_limit: z.number().int().min(1).max(256).optional(),
    })
    .strict(),
]);

export type NoProgressOverride = z.infer<typeof NoProgressOverrideSchema>;

/** One bounded recent-history entry: only hashes, never raw evidence. */
export const NoProgressHistoryEntrySchema = z
  .object({
    action_signature: z.string(),
    outcome_signature: z.string(),
    succeeded: z.boolean(),
  })
  .strict();

export type NoProgressHistoryEntry = z.infer<typeof NoProgressHistoryEntrySchema>;

/**
 * Durable, restart-safe state. Serialized as JSON into `capability_state[tfy.no_progress]`, so every
 * field is JSON-safe and evidence-free.
 */
export const NoProgressStateSchema = z
  .object({
    version: z.literal(STATE_VERSION),
    /** Monotonic progress epoch; advances whenever real progress resets the counter. */
    epoch: z.number().int().nonnegative(),
    /** Consecutive no-progress steps within the current epoch. */
    no_progress_count: z.number().int().nonnegative(),
    /** Action signature of the last observed batch (null before the first observation). */
    last_action_signature: z.string().nullable(),
    /** Outcome signature of the last observed batch. */
    last_outcome_signature: z.string().nullable(),
    /** Whether the last observed batch succeeded. */
    last_succeeded: z.boolean().nullable(),
    /** Whether the first failure of the current epoch has already been counted. */
    first_failure_counted: z.boolean(),
    /** Bounded recent history (most recent last). */
    recent: z.array(NoProgressHistoryEntrySchema),
    /** How many reminders/replans have been emitted in the current epoch (for idempotent guidance). */
    reminders_emitted: z.number().int().nonnegative(),
    replans_emitted: z.number().int().nonnegative(),
    /** Whether a stop has been signaled (latched until progress resets the epoch). */
    stopped: z.boolean(),
  })
  .strict();

export type NoProgressState = z.infer<typeof NoProgressStateSchema>;

export function createInitialNoProgressState(): NoProgressState {
  return {
    version: STATE_VERSION,
    epoch: 0,
    no_progress_count: 0,
    last_action_signature: null,
    last_outcome_signature: null,
    last_succeeded: null,
    first_failure_counted: false,
    recent: [],
    reminders_emitted: 0,
    replans_emitted: 0,
    stopped: false,
  };
}

/**
 * Rehydrate durable state. Any malformed / version-mismatched / absent value fails safe to a fresh
 * initial state rather than throwing, so a corrupt snapshot can never wedge a live turn.
 */
export function rehydrateNoProgressState(raw: unknown): NoProgressState {
  if (raw === null || raw === undefined) {
    return createInitialNoProgressState();
  }
  const parsed = NoProgressStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : createInitialNoProgressState();
}

/** A single observed call, reduced to its bounded action components before hashing. */
export interface ObservedCall {
  /** Stable tool-set id resolved from the governing policy identity. */
  stable_tool_set_id: string;
  /** Original (server-side) tool name, independent of any wrapper alias. */
  original_tool_name: string;
  /** Shared canonical argument fingerprint. */
  argument_fingerprint: string;
  /** Normalized result content (success) — hashed, never stored. */
  normalized_result: string;
  /** Whether this call failed. */
  failed: boolean;
}

export type NoProgressLevel = 'none' | 'reminder' | 'replan' | 'stop';

export interface NoProgressObservation {
  level: NoProgressLevel;
  /** Post-observation state to persist immediately. */
  state: NoProgressState;
  /** Consecutive no-progress steps after this observation. */
  no_progress_count: number;
  /** Progress epoch after this observation. */
  epoch: number;
}

/**
 * Order-independent action signature over a batch. Each call contributes a component hash of
 * `(stable_tool_set_id, original_tool_name, argument_fingerprint)`; components are sorted so neither
 * tool-call id nor batch order affects the result. Cosmetically-equivalent batches (same actions,
 * different order) hash identically.
 */
export function computeActionSignature(calls: readonly ObservedCall[]): string {
  const components = calls
    .map(call =>
      fingerprintArguments({
        s: call.stable_tool_set_id,
        t: call.original_tool_name,
        a: call.argument_fingerprint,
      }),
    )
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(components)).digest('hex');
}

/**
 * Order-independent outcome signature over a batch. Hashes the normalized result content and failure
 * flag of each call, sorted, with no raw arguments or output retained.
 */
export function computeOutcomeSignature(calls: readonly ObservedCall[]): string {
  const components = calls
    .map(call => fingerprintArguments({ f: call.failed, r: call.normalized_result }))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(components)).digest('hex');
}

/** Normalize a tool result value into a bounded, evidence-free hash pre-image. */
export function normalizeResultContent(content: unknown): string {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (content === null || content === undefined) {
    text = String(content);
  } else if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint') {
    text = String(content);
  } else {
    // Objects / arrays: deterministic JSON. A non-serializable value (e.g. a cycle) falls back to a
    // stable, evidence-free marker rather than Object's default stringification.
    try {
      text = JSON.stringify(content);
    } catch {
      text = '[unserializable]';
    }
  }
  // Collapse insignificant whitespace so cosmetic reformatting counts as the same outcome.
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return fingerprintArguments(collapsed);
}

/**
 * Fixed-core, default-on no-progress controller. One instance per {@link AgentThread}; its live
 * state mirrors the durable `tfy.no_progress` capability_state and is persisted immediately after
 * each observation.
 */
export class NoProgressController {
  private readonly config: NoProgressConfig;
  private state: NoProgressState;

  constructor(options: { config?: NoProgressConfig | undefined; state?: NoProgressState | undefined } = {}) {
    this.config = options.config ?? NoProgressConfigSchema.parse({});
    this.state = options.state ?? createInitialNoProgressState();
  }

  /**
   * Resolve a validated config from a per-agent override. `false` disables; an object is merged onto
   * safe defaults and validated (ordering enforced); `undefined`/`true` yields defaults.
   */
  static resolveConfig(override: NoProgressOverride | undefined): NoProgressConfig {
    if (override === false) {
      return NoProgressConfigSchema.parse({ enabled: false });
    }
    if (override === undefined || override === true) {
      return NoProgressConfigSchema.parse({});
    }
    return NoProgressConfigSchema.parse({ enabled: true, ...override });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get currentState(): NoProgressState {
    return this.state;
  }

  get resolvedConfig(): NoProgressConfig {
    return this.config;
  }

  /**
   * Observe one completed ordinary model tool batch, apply the progress model, advance and persist
   * state locally, and return the enforcement level for this step. A disabled controller or an empty
   * batch is a no-op.
   */
  observe(calls: readonly ObservedCall[]): NoProgressObservation {
    if (!this.config.enabled || calls.length === 0) {
      return {
        level: 'none',
        state: this.state,
        no_progress_count: this.state.no_progress_count,
        epoch: this.state.epoch,
      };
    }

    const actionSignature = computeActionSignature(calls);
    const outcomeSignature = computeOutcomeSignature(calls);
    const succeeded = calls.every(call => !call.failed);

    const prev = this.state;
    const sameAction = prev.last_action_signature === actionSignature;
    const sameOutcome = prev.last_outcome_signature === outcomeSignature;

    let next: NoProgressState;

    if (succeeded && (!sameAction || !sameOutcome)) {
      // Progress: a new successful action, or a changed successful outcome. Reset and open a new epoch.
      // This — and only this — resets the budget.
      next = this.startNewEpoch({ actionSignature, outcomeSignature, succeeded });
    } else if (!succeeded && !prev.first_failure_counted) {
      // First failure of the epoch counts as one no-progress step.
      next = this.incrementNoProgress({ actionSignature, outcomeSignature, succeeded, firstFailure: true });
    } else {
      // Any other outcome is not progress and increments the same budget:
      //  - a *different* failed alternative (still failing, so not progress — trying alternatives that
      //    keep failing must not be able to evade the budget by rotating arguments/tools);
      //  - an exact repeat or cosmetic variant of a failing action (same action, same/changed detail);
      //  - a repeated successful action with the same outcome (no forward motion).
      // Distinct failed alternatives, exact repeats, and cosmetic variants all land here and increment,
      // so an alternating- or rotating-failure loop is strictly bounded and cannot hold below the stop
      // threshold. The `firstFailure` flag stays false: the first-failure credit is already spent, and
      // this path only ever adds to an epoch that has already recorded its first step.
      next = this.incrementNoProgress({ actionSignature, outcomeSignature, succeeded, firstFailure: false });
    }

    const level = this.classify(next);
    next = this.applyLevelLatch(next, level);
    this.state = next;
    return { level, state: next, no_progress_count: next.no_progress_count, epoch: next.epoch };
  }

  private classify(state: NoProgressState): NoProgressLevel {
    const count = state.no_progress_count;
    if (count >= this.config.stop_threshold) {
      return 'stop';
    }
    if (count >= this.config.replan_threshold) {
      return 'replan';
    }
    if (count >= this.config.reminder_threshold) {
      return 'reminder';
    }
    return 'none';
  }

  private applyLevelLatch(state: NoProgressState, level: NoProgressLevel): NoProgressState {
    if (level === 'stop') {
      return { ...state, stopped: true };
    }
    if (level === 'replan') {
      return { ...state, replans_emitted: state.replans_emitted + 1 };
    }
    if (level === 'reminder') {
      return { ...state, reminders_emitted: state.reminders_emitted + 1 };
    }
    return state;
  }

  private startNewEpoch(input: {
    actionSignature: string;
    outcomeSignature: string;
    succeeded: boolean;
  }): NoProgressState {
    return {
      version: STATE_VERSION,
      epoch: this.state.epoch + 1,
      no_progress_count: 0,
      last_action_signature: input.actionSignature,
      last_outcome_signature: input.outcomeSignature,
      last_succeeded: input.succeeded,
      first_failure_counted: false,
      recent: this.pushHistory(input),
      reminders_emitted: 0,
      replans_emitted: 0,
      stopped: false,
    };
  }

  private incrementNoProgress(input: {
    actionSignature: string;
    outcomeSignature: string;
    succeeded: boolean;
    firstFailure: boolean;
  }): NoProgressState {
    return {
      ...this.state,
      no_progress_count: this.state.no_progress_count + 1,
      last_action_signature: input.actionSignature,
      last_outcome_signature: input.outcomeSignature,
      last_succeeded: input.succeeded,
      first_failure_counted: this.state.first_failure_counted || (!input.succeeded && input.firstFailure),
      recent: this.pushHistory(input),
    };
  }

  private pushHistory(input: {
    actionSignature: string;
    outcomeSignature: string;
    succeeded: boolean;
  }): NoProgressHistoryEntry[] {
    const entry: NoProgressHistoryEntry = {
      action_signature: input.actionSignature,
      outcome_signature: input.outcomeSignature,
      succeeded: input.succeeded,
    };
    const history = [...this.state.recent, entry];
    if (history.length > this.config.history_limit) {
      return history.slice(history.length - this.config.history_limit);
    }
    return history;
  }
}

/**
 * Bounded ephemeral guidance text for a reminder/replan. Not durable user content — the caller
 * injects it into the next LLM request only. Kept short and evidence-free.
 */
export function noProgressGuidance(level: 'reminder' | 'replan', noProgressCount: number): string {
  if (level === 'replan') {
    return (
      `You have repeated the same action ${String(noProgressCount)} times without making progress. ` +
      `Stop repeating it. Re-plan: state a different strategy, cite the concrete new evidence or ` +
      `constraint you will act on, and take a materially different next step. Do not retry the same ` +
      `tool call with the same arguments.`
    );
  }
  return (
    `Your last ${String(noProgressCount)} attempts produced no progress. Change your approach before ` +
    `the next tool call: use different arguments or a different tool, or gather new evidence first. ` +
    `Do not repeat the same failing action.`
  );
}

/** Bounded, structured stop message surfaced through the existing error event path. */
export function noProgressStopMessage(noProgressCount: number, epoch: number): string {
  return (
    `Stopping: no progress after ${String(noProgressCount)} consecutive equivalent tool actions ` +
    `(progress epoch ${String(epoch)}). The agent repeated the same action and outcome without ` +
    `advancing, and reminder/replan guidance did not change the strategy. Terminating before another ` +
    `model or tool dispatch.`
  );
}
