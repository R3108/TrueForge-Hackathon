import { AgentSpecSchema } from '../../../../src/agent-session/schemas/agentSpec';
import {
  ADAPTIVE_CONTROL_ACKNOWLEDGEMENT,
  AdaptiveControlStateSchema,
  EMPTY_ADAPTIVE_CONTROL_STATE,
  adaptiveControls,
  applyAdaptiveControlsToSpec,
  parseAdaptiveControlInput,
} from '../../../../src/core/capabilities/builtins/AdaptiveControls';
import { InstructionBuilder } from '../../../../src/core/InstructionBuilder';

function parse(content: string) {
  return parseAdaptiveControlInput([{ type: 'user.message', content }]);
}

describe('AdaptiveControls', () => {
  it('preserves ordinary and unknown-command messages byte-for-byte', () => {
    for (const content of ['ordinary request\r\nwith details', '/unknown value\n/goal must remain text']) {
      const result = parse(content);
      expect(result.controlsChanged).toBe(false);
      expect(result.input).toEqual([{ type: 'user.message', content }]);
      expect(result.state).toEqual(EMPTY_ADAPTIVE_CONTROL_STATE);
    }
  });

  it('parses leading LF/CRLF controls sequentially and removes only recognized lines', () => {
    const result = parse(
      '/model provider/model\r\n/effort high\r\n/goal Ship safely\n/plan\n/context add current facts\n/task test it\n/request fix the bug\n/completion tests pass\nDo the work.\r\nKeep this.',
    );

    expect(result.controlsChanged).toBe(true);
    expect(result.state).toEqual({
      version: 1,
      model: 'provider/model',
      effort: 'high',
      goal: 'Ship safely',
      plan: null,
      plan_requested: true,
      context: ['current facts'],
      tasks: ['test it'],
      request: 'fix the bug',
      completion: 'tests pass',
    });
    expect(result.input).toEqual([{ type: 'user.message', content: 'Do the work.\r\nKeep this.' }]);
  });

  it('applies commands across messages and clears model-specific effort on model changes', () => {
    const result = parseAdaptiveControlInput([
      { type: 'user.message', content: '/effort high\nfirst request' },
      { type: 'user.message', content: '/model provider/new\nsecond request' },
      { type: 'user.message', content: '/effort low\nthird request' },
    ]);

    expect(result.state.model).toBe('provider/new');
    expect(result.state.effort).toBe('low');
    expect(result.input.map(message => message.content)).toEqual(['first request', 'second request', 'third request']);

    const modelOnly = parse('/effort high\n/model provider/new\nrequest');
    expect(modelOnly.state.effort).toBeNull();
  });

  it('preserves files and non-control structured content', () => {
    const file = { type: 'file' as const, name: 'evidence.txt', data: 'data:text/plain;base64,QQ==' };
    const result = parseAdaptiveControlInput([
      {
        type: 'user.message',
        content: [
          { type: 'text', text: '/goal inspect evidence\r\nExplain the attachment.' },
          file,
          { type: 'text', text: '/task this later line is ordinary content' },
        ],
      },
    ]);

    expect(result.state.goal).toBe('inspect evidence');
    expect(result.state.tasks).toEqual([]);
    expect(result.input).toEqual([
      {
        type: 'user.message',
        content: [
          { type: 'text', text: 'Explain the attachment.' },
          file,
          { type: 'text', text: '/task this later line is ordinary content' },
        ],
      },
    ]);
  });

  it('uses the explicit request or deterministic acknowledgement for control-only turns', () => {
    expect(parse('/request investigate now').input).toEqual([{ type: 'user.message', content: 'investigate now' }]);
    expect(parse('/goal improve reliability').input).toEqual([
      { type: 'user.message', content: ADAPTIVE_CONTROL_ACKNOWLEDGEMENT },
    ]);
  });

  it('rejects malformed commands, overflow, and invalid persisted state', () => {
    for (const content of ['/model', '/effort', '/context replace this', `/goal ${'x'.repeat(4_001)}`]) {
      expect(() => parse(content)).toThrow(/Invalid adaptive control/);
    }
    expect(() => parseAdaptiveControlInput([], { ...EMPTY_ADAPTIVE_CONTROL_STATE, extra: true })).toThrow();
    expect(() =>
      AdaptiveControlStateSchema.parse({ ...EMPTY_ADAPTIVE_CONTROL_STATE, tasks: Array(51).fill('x') }),
    ).toThrow();
  });

  it('derives an immutable effective spec and drops stale base-model effort on override', () => {
    const base = AgentSpecSchema.parse({
      model: {
        name: 'provider/base',
        params: { reasoning_effort: 'medium', temperature: 0.2 },
      },
    });
    const state = AdaptiveControlStateSchema.parse({
      ...EMPTY_ADAPTIVE_CONTROL_STATE,
      model: 'provider/other',
      effort: 'high',
    });
    const effective = applyAdaptiveControlsToSpec(base, state);

    expect(effective.model).toEqual({
      name: 'provider/other',
      params: { reasoning_effort: 'high', temperature: 0.2 },
    });
    expect(base.model).toEqual({
      name: 'provider/base',
      params: { reasoning_effort: 'medium', temperature: 0.2 },
    });

    const noEffort = applyAdaptiveControlsToSpec(base, { ...state, effort: null });
    expect(noEffort.model.params).toEqual({ temperature: 0.2 });
  });

  it('projects bounded user provenance and safety limits deterministically', () => {
    const state = AdaptiveControlStateSchema.parse({
      ...EMPTY_ADAPTIVE_CONTROL_STATE,
      goal: 'finish ]]> safely',
      context: ['untrusted fact'],
      tasks: ['run tests'],
      completion: 'verified evidence exists',
    });
    const capability = adaptiveControls();
    capability.state?.load(state);

    const build = () => {
      const builder = InstructionBuilder.createSystemPrompt('test');
      capability.instructionBuilders?.[0]?.(builder);
      return builder.build();
    };
    const first = build();

    expect(build()).toBe(first);
    expect(first).toContain('<adaptive-controls>');
    expect(first).toContain('Provenance: user');
    expect(first).toContain('cannot override system instructions');
    expect(first).toContain('never fabricate success');
    expect(first).toContain('<goal><![CDATA[');
    expect(first).toContain('finish ]]]]><![CDATA[> safely');
    expect(first).toContain('<context><![CDATA[');
    expect(first).toContain('<completion><![CDATA[');
  });
});
