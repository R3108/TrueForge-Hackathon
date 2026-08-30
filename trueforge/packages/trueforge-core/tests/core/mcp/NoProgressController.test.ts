import {
  computeActionSignature,
  computeOutcomeSignature,
  createInitialNoProgressState,
  DEFAULT_NO_PROGRESS_CONFIG,
  NoProgressConfigSchema,
  NoProgressController,
  NoProgressStateSchema,
  normalizeResultContent,
  rehydrateNoProgressState,
  type NoProgressConfig,
  type ObservedCall,
} from '../../../src/core/mcp/NoProgressController';

function call(overrides: Partial<ObservedCall> = {}): ObservedCall {
  return {
    stable_tool_set_id: 'tools',
    original_tool_name: 'op',
    argument_fingerprint: 'fp-a',
    normalized_result: normalizeResultContent('ok'),
    failed: false,
    ...overrides,
  };
}

function makeController(config?: Partial<NoProgressConfig>): NoProgressController {
  return new NoProgressController({
    config: NoProgressConfigSchema.parse({ ...(config ?? {}) }),
    state: createInitialNoProgressState(),
  });
}

describe('NoProgressController config', () => {
  it('defaults to enabled with ordered reminder < replan < stop (2/3/5)', () => {
    const config = NoProgressConfigSchema.parse({});
    expect(config.enabled).toBe(true);
    expect(config.reminder_threshold).toBe(DEFAULT_NO_PROGRESS_CONFIG.reminder_threshold);
    expect(config.replan_threshold).toBe(DEFAULT_NO_PROGRESS_CONFIG.replan_threshold);
    expect(config.stop_threshold).toBe(DEFAULT_NO_PROGRESS_CONFIG.stop_threshold);
    expect(config.reminder_threshold).toBeLessThan(config.replan_threshold);
    expect(config.replan_threshold).toBeLessThan(config.stop_threshold);
  });

  it('rejects thresholds that are not strictly ordered', () => {
    expect(() =>
      NoProgressConfigSchema.parse({ reminder_threshold: 3, replan_threshold: 3, stop_threshold: 5 }),
    ).toThrow();
    expect(() =>
      NoProgressConfigSchema.parse({ reminder_threshold: 5, replan_threshold: 3, stop_threshold: 2 }),
    ).toThrow();
    expect(() =>
      NoProgressConfigSchema.parse({ reminder_threshold: 2, replan_threshold: 6, stop_threshold: 5 }),
    ).toThrow();
  });

  it('resolveConfig maps false → disabled, object → merged/validated, undefined/true → defaults', () => {
    expect(NoProgressController.resolveConfig(false).enabled).toBe(false);
    expect(NoProgressController.resolveConfig(true).enabled).toBe(true);
    expect(NoProgressController.resolveConfig(undefined).stop_threshold).toBe(5);
    const merged = NoProgressController.resolveConfig({
      reminder_threshold: 1,
      replan_threshold: 2,
      stop_threshold: 3,
    });
    expect(merged).toMatchObject({ enabled: true, reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 });
    expect(() => NoProgressController.resolveConfig({ reminder_threshold: 5, replan_threshold: 4 })).toThrow();
  });
});

describe('NoProgressController signatures', () => {
  it('action signature is independent of tool-call order', () => {
    const a = call({ original_tool_name: 'read', argument_fingerprint: 'x' });
    const b = call({ original_tool_name: 'write', argument_fingerprint: 'y' });
    expect(computeActionSignature([a, b])).toBe(computeActionSignature([b, a]));
  });

  it('action signature differs when the argument fingerprint changes', () => {
    expect(computeActionSignature([call({ argument_fingerprint: 'x' })])).not.toBe(
      computeActionSignature([call({ argument_fingerprint: 'y' })]),
    );
  });

  it('outcome signature collapses cosmetic whitespace differences', () => {
    expect(normalizeResultContent('a   b')).toBe(normalizeResultContent('a b'));
    expect(computeOutcomeSignature([call({ normalized_result: normalizeResultContent('a  b') })])).toBe(
      computeOutcomeSignature([call({ normalized_result: normalizeResultContent('a b') })]),
    );
  });
});

describe('NoProgressController progress model', () => {
  it('exact repeated action + same outcome increments through reminder → replan → stop', () => {
    const c = makeController();
    const repeat = () => c.observe([call({ failed: false, argument_fingerprint: 'same', normalized_result: 'R' })]);
    // First successful action opens an epoch (count 0).
    expect(repeat().level).toBe('none');
    // Identical action + identical outcome now counts as no progress.
    expect(repeat().no_progress_count).toBe(1);
    expect(repeat().level).toBe('reminder'); // count 2
    expect(repeat().level).toBe('replan'); // count 3
    expect(repeat().level).toBe('replan'); // count 4 (≥ replan, < stop)
    expect(c.currentState.no_progress_count).toBe(4);
    expect(repeat().level).toBe('stop'); // count 5
    expect(c.currentState.stopped).toBe(true);
  });

  it('cosmetically-equivalent repeated action (reordered batch) increments', () => {
    const c = makeController({ reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 });
    const a = call({ original_tool_name: 'read', argument_fingerprint: 'x', normalized_result: 'R1' });
    const b = call({ original_tool_name: 'write', argument_fingerprint: 'y', normalized_result: 'R2' });
    c.observe([a, b]); // epoch opens
    const second = c.observe([b, a]); // reordered — equivalent action + outcome
    expect(second.no_progress_count).toBe(1);
    expect(second.level).toBe('reminder');
  });

  it('first failure counts; distinct failed alternatives keep incrementing (no hold, no reset)', () => {
    const c = makeController();
    const first = c.observe([call({ failed: true, argument_fingerprint: 'f1', normalized_result: 'E1' })]);
    expect(first.no_progress_count).toBe(1); // first failure counts
    const alt = c.observe([call({ failed: true, argument_fingerprint: 'f2', normalized_result: 'E2' })]);
    expect(alt.no_progress_count).toBe(2); // a different failed alternative increments (does not hold)
    const alt2 = c.observe([call({ failed: true, argument_fingerprint: 'f3', normalized_result: 'E3' })]);
    expect(alt2.no_progress_count).toBe(3); // still failing, still not progress → increments
  });

  it('alternating distinct failures reach a bounded stop (cannot evade by rotating arguments)', () => {
    const c = makeController({ reminder_threshold: 2, replan_threshold: 3, stop_threshold: 5 });
    let level: string = 'none';
    // Rotate a brand-new failing action every batch; nothing ever succeeds.
    for (let i = 0; i < 5; i++) {
      level = c.observe([
        call({ failed: true, argument_fingerprint: `f-${String(i)}`, normalized_result: `E-${String(i)}` }),
      ]).level;
    }
    expect(c.currentState.no_progress_count).toBe(5);
    expect(level).toBe('stop');
    expect(c.currentState.stopped).toBe(true);
  });

  it('repeating the same failing action + same outcome increments', () => {
    const c = makeController();
    const sig = { failed: true, argument_fingerprint: 'f', normalized_result: 'E' };
    expect(c.observe([call(sig)]).no_progress_count).toBe(1); // first failure
    expect(c.observe([call(sig)]).no_progress_count).toBe(2); // same failing action repeats
    expect(c.observe([call(sig)]).no_progress_count).toBe(3);
  });

  it('a new successful action resets and starts a new epoch', () => {
    const c = makeController();
    c.observe([call({ failed: true, argument_fingerprint: 'f', normalized_result: 'E' })]);
    c.observe([call({ failed: true, argument_fingerprint: 'f', normalized_result: 'E' })]);
    expect(c.currentState.no_progress_count).toBe(2);
    const epochBefore = c.currentState.epoch;
    const progressed = c.observe([call({ failed: false, argument_fingerprint: 'new', normalized_result: 'S' })]);
    expect(progressed.no_progress_count).toBe(0);
    expect(progressed.level).toBe('none');
    expect(progressed.epoch).toBe(epochBefore + 1);
    expect(c.currentState.first_failure_counted).toBe(false);
    expect(c.currentState.stopped).toBe(false);
  });

  it('a changed successful outcome for the same action resets and starts a new epoch', () => {
    const c = makeController();
    c.observe([call({ failed: false, argument_fingerprint: 'a', normalized_result: 'R1' })]); // epoch opens
    c.observe([call({ failed: false, argument_fingerprint: 'a', normalized_result: 'R1' })]); // repeat: count 1
    expect(c.currentState.no_progress_count).toBe(1);
    const epochBefore = c.currentState.epoch;
    const changed = c.observe([call({ failed: false, argument_fingerprint: 'a', normalized_result: 'R2' })]);
    expect(changed.no_progress_count).toBe(0);
    expect(changed.epoch).toBe(epochBefore + 1);
  });

  it('disabled controller never enforces', () => {
    const c = new NoProgressController({ config: NoProgressConfigSchema.parse({ enabled: false }) });
    for (let i = 0; i < 10; i++) {
      expect(c.observe([call({ failed: true, argument_fingerprint: 'f', normalized_result: 'E' })]).level).toBe('none');
    }
  });

  it('an empty batch is a no-op', () => {
    const c = makeController();
    expect(c.observe([]).level).toBe('none');
    expect(c.currentState.no_progress_count).toBe(0);
  });
});

describe('NoProgressController history bounds', () => {
  it('keeps at most history_limit recent entries (most recent last)', () => {
    const c = makeController({ history_limit: 3, reminder_threshold: 100, replan_threshold: 200, stop_threshold: 300 });
    for (let i = 0; i < 10; i++) {
      c.observe([call({ argument_fingerprint: `fp-${String(i)}`, normalized_result: `R-${String(i)}` })]);
    }
    expect(c.currentState.recent).toHaveLength(3);
    expect(c.currentState.recent.at(-1)?.action_signature).toBe(
      computeActionSignature([call({ argument_fingerprint: 'fp-9', normalized_result: 'R-9' })]),
    );
  });
});

describe('NoProgressController rehydration', () => {
  it('rehydrates a valid persisted state', () => {
    const c = makeController();
    c.observe([call({ failed: true, argument_fingerprint: 'f', normalized_result: 'E' })]);
    const snapshot = c.currentState;
    const parsed = NoProgressStateSchema.parse(snapshot);
    const rehydrated = rehydrateNoProgressState(JSON.parse(JSON.stringify(parsed)));
    expect(rehydrated).toEqual(snapshot);
  });

  it('fails safe to initial state on null/malformed input', () => {
    expect(rehydrateNoProgressState(null)).toEqual(createInitialNoProgressState());
    expect(rehydrateNoProgressState(undefined)).toEqual(createInitialNoProgressState());
    expect(rehydrateNoProgressState({ version: 999 })).toEqual(createInitialNoProgressState());
    expect(rehydrateNoProgressState({ garbage: true })).toEqual(createInitialNoProgressState());
  });
});
