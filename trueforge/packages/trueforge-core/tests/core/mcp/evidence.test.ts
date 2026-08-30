import {
  EventType,
  ToolAttemptCompletedEventSchema,
  ToolExecutionLifecycleEventSchema,
  type ToolExecutionLifecycleEvent,
} from '../../../src/core/events/schema';
import {
  EVIDENCE_RECORD_VERSION,
  EvidenceRecordSchema,
  VerificationCoordinator,
  type EvidenceSourceIdentity,
} from '../../../src/core/mcp/evidence';
import type { CallToolResponse, IToolSet } from '../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { type ToolCapability } from '../../../src/core/mcp/ToolCapabilityRegistry';
import {
  ToolExecutionCoordinator,
  type ToolExecutionContext,
  type ToolExecutionInvocation,
} from '../../../src/core/mcp/ToolExecutionCoordinator';
import { makeMockIMCPServer } from '../harnessMocks';

const CONTEXT: ToolExecutionContext = {
  session_id: 'session-1',
  turn_id: 'turn-1',
  thread_id: 'main',
  model_message_id: 'message-1',
  root_tool_call_id: null,
  parent_tool_call_id: null,
  signal: undefined,
  event_recorder: undefined,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, count: { type: 'integer' } },
  required: ['ok', 'count'],
  additionalProperties: false,
} as const;

const SOURCE: EvidenceSourceIdentity = {
  session_id: 'session-1',
  turn_id: 'turn-1',
  thread_id: 'main',
  stable_tool_set_id: 'server',
  tool_name: 'verify',
  tool_call_id: 'call-1',
  root_tool_call_id: 'call-1',
  attempt_id: '00000000-0000-4000-8000-000000000000',
};

function capability(overrides: Partial<ToolCapability> = {}): ToolCapability {
  return {
    stable_tool_set_id: 'server',
    tool_name: 'verify',
    side_effect_class: 'read_only',
    retry_capability: 'never',
    concurrency: { kind: 'exclusive' },
    timeout_ms: null,
    output_schema: null,
    result_size_class: 'small',
    evidence_capabilities: [],
    sensitive_argument_paths: [],
    tags: [],
    ...overrides,
  };
}

function structuredResponse(structuredContent: Record<string, unknown>, text = 'ok'): CallToolResponse {
  return {
    result: { content: [{ type: 'text', text }], structuredContent },
    wasInitialized: undefined,
  };
}

function server(): IToolSet {
  const s = makeMockIMCPServer({ name: 'server', preload: true });
  jest.mocked(s.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: 'server',
    mcp_server_name: 'server',
    original_tool_name: 'verify',
    is_approval_required: false,
  });
  return s;
}

function invocation(input: {
  server: IToolSet | undefined;
  toolName?: string;
  args?: unknown;
}): ToolExecutionInvocation {
  return {
    tool_call_id: 'call-1',
    tool_set: input.server,
    tool_name: input.toolName ?? 'verify',
    arguments: input.args ?? '{}',
    approval_decision: undefined,
  };
}

function coordinatorWithCapability(cap: ToolCapability, s: IToolSet): ToolExecutionCoordinator {
  s.getToolCapability = () => cap;
  return new ToolExecutionCoordinator();
}

describe('VerificationCoordinator (unit)', () => {
  const verifier = new VerificationCoordinator({ now: () => new Date('2026-01-01T00:00:00.000Z') });

  it('mints one bounded typed evidence record per declared capability from valid structured output', () => {
    const result = verifier.verify({
      output_schema: OUTPUT_SCHEMA,
      evidence_capabilities: ['test.passed', 'coverage.recorded'],
      structured_content: { ok: true, count: 3 },
      source: SOURCE,
    });
    expect(result.kind).toBe('verified');
    if (result.kind !== 'verified') throw new Error('expected verified');
    expect(result.evidence).toHaveLength(2);
    for (const record of result.evidence) {
      // Parses against the Zod contract and contains no raw output/args/secrets.
      expect(() => EvidenceRecordSchema.parse(record)).not.toThrow();
      expect(record.version).toBe(EVIDENCE_RECORD_VERSION);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('"count":3');
      expect(serialized).not.toContain('true');
      expect(record.id).toHaveLength(64);
      expect(record.schema_digest).toHaveLength(64);
      expect(record.result_digest).toHaveLength(64);
    }
    expect(result.evidence.map(r => r.evidence_capability)).toEqual(['test.passed', 'coverage.recorded']);
  });

  it('produces deterministic ids/digests independent of observed_at', () => {
    const early = new VerificationCoordinator({ now: () => new Date('2020-01-01T00:00:00.000Z') });
    const late = new VerificationCoordinator({ now: () => new Date('2030-06-06T06:06:06.000Z') });
    const a = early.verify({
      output_schema: OUTPUT_SCHEMA,
      evidence_capabilities: ['test.passed'],
      structured_content: { count: 3, ok: true },
      source: SOURCE,
    });
    const b = late.verify({
      output_schema: OUTPUT_SCHEMA,
      evidence_capabilities: ['test.passed'],
      // Different key order — canonicalization must make the digests identical.
      structured_content: { ok: true, count: 3 },
      source: SOURCE,
    });
    if (a.kind !== 'verified' || b.kind !== 'verified') throw new Error('expected verified');
    expect(a.evidence[0]?.id).toBe(b.evidence[0]?.id);
    expect(a.evidence[0]?.result_digest).toBe(b.evidence[0]?.result_digest);
    expect(a.evidence[0]?.observed_at).not.toBe(b.evidence[0]?.observed_at);
  });

  it('fails a schema mismatch with bounded violations and zero evidence', () => {
    const result = verifier.verify({
      output_schema: OUTPUT_SCHEMA,
      evidence_capabilities: ['test.passed'],
      structured_content: { ok: 'yes', count: 3 },
      source: SOURCE,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('output_schema_validation_failed');
    expect(result.error.violations.length).toBeGreaterThan(0);
  });

  it('rejects missing structured content (prose-only success) with zero evidence', () => {
    const result = verifier.verify({
      output_schema: OUTPUT_SCHEMA,
      evidence_capabilities: ['test.passed'],
      structured_content: undefined,
      source: SOURCE,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('missing_structured_content');
    expect(result.error.violations).toEqual([]);
  });

  it('skips (no evidence) when the output schema is null even if evidence capabilities are declared', () => {
    const result = verifier.verify({
      output_schema: null,
      evidence_capabilities: ['test.passed'],
      structured_content: { ok: true, count: 3 },
      source: SOURCE,
    });
    expect(result.kind).toBe('skipped');
  });

  it('de-duplicates and ignores empty capability names deterministically', () => {
    const result = verifier.verify({
      output_schema: OUTPUT_SCHEMA,
      evidence_capabilities: ['a', 'a', '', 'b'],
      structured_content: { ok: true, count: 1 },
      source: SOURCE,
    });
    if (result.kind !== 'verified') throw new Error('expected verified');
    expect(result.evidence.map(r => r.evidence_capability)).toEqual(['a', 'b']);
  });

  describe('identity-less calls (absent durable source)', () => {
    for (const source of [null, undefined] as const) {
      const label = source === null ? 'null' : 'undefined';

      it(`rejects prose-only success as a validation failure even when source is ${label}`, () => {
        const result = verifier.verify({
          output_schema: OUTPUT_SCHEMA,
          evidence_capabilities: ['test.passed'],
          structured_content: undefined,
          source,
        });
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') throw new Error('expected failed');
        expect(result.error.code).toBe('missing_structured_content');
        expect(result.error.violations).toEqual([]);
      });

      it(`fails a schema mismatch with bounded violations even when source is ${label}`, () => {
        const result = verifier.verify({
          output_schema: OUTPUT_SCHEMA,
          evidence_capabilities: ['test.passed'],
          structured_content: { ok: 'yes', count: 3 },
          source,
        });
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') throw new Error('expected failed');
        expect(result.error.code).toBe('output_schema_validation_failed');
        expect(result.error.violations.length).toBeGreaterThan(0);
      });

      it(`verifies valid structured output evidence-free (never fabricates identity) when source is ${label}`, () => {
        const result = verifier.verify({
          output_schema: OUTPUT_SCHEMA,
          evidence_capabilities: ['test.passed', 'coverage.recorded'],
          structured_content: { ok: true, count: 3 },
          source,
        });
        expect(result.kind).toBe('verified');
        if (result.kind !== 'verified') throw new Error('expected verified');
        // Verified but evidence-free: declared capabilities never mint a record without durable identity.
        expect(result.evidence).toEqual([]);
      });

      it(`still skips a null output schema when source is ${label}`, () => {
        const result = verifier.verify({
          output_schema: null,
          evidence_capabilities: ['test.passed'],
          structured_content: { ok: true, count: 3 },
          source,
        });
        expect(result.kind).toBe('skipped');
      });
    }
  });
});

describe('ToolExecutionCoordinator verification finalization', () => {
  function structuredContentOf(response: CallToolResponse): Record<string, unknown> | undefined {
    if (!isCallToolResponseResult(response)) return undefined;
    return response.result.structuredContent;
  }

  it('attaches typed evidence to a successful outcome with valid structured output', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(structuredResponse({ ok: true, count: 5 }));
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, evidence_capabilities: ['test.passed'] }),
      s,
    );
    const events: ToolExecutionLifecycleEvent[] = [];
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ server: s }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          events.push(ToolExecutionLifecycleEventSchema.parse(event));
          return Promise.resolve();
        },
      },
    });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.evidence).toHaveLength(1);
    expect(outcome.evidence[0]?.evidence_capability).toBe('test.passed');
    expect(outcome.evidence[0]?.source.attempt_id).toBe(outcome.attempt_id);

    const completed = events.find(e => e.type === EventType.TOOL_ATTEMPT_COMPLETED);
    if (completed?.type !== EventType.TOOL_ATTEMPT_COMPLETED) throw new Error('expected completion');
    expect(completed.evidence).toHaveLength(1);
    expect(completed.evidence?.[0]?.id).toBe(outcome.evidence[0]?.id);
  });

  it('turns a schema mismatch into a validation failure with no evidence and no retry', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(structuredResponse({ ok: 'nope', count: 5 }));
    const coordinator = coordinatorWithCapability(
      capability({
        output_schema: OUTPUT_SCHEMA,
        evidence_capabilities: ['test.passed'],
        // Even a retry-safe read must not retry a validation failure.
        side_effect_class: 'read_only',
        retry_capability: 'safe',
      }),
      s,
    );
    const outcome = await coordinator.executeInvocation({ invocation: invocation({ server: s }), context: CONTEXT });

    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('validation');
    expect(outcome.evidence).toEqual([]);
    expect(s.callTool).toHaveBeenCalledTimes(1);
    const text = isCallToolResponseResult(outcome.response) ? outcome.response.result.content[0] : undefined;
    expect(text?.type === 'text' ? text.text : '').toContain('output_schema_validation_failed');
  });

  it('treats prose-only success (no structured content) as a validation failure with no evidence', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(toolResultResponse({ text: 'I promise the tests passed.' }));
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, evidence_capabilities: ['test.passed'] }),
      s,
    );
    const outcome = await coordinator.executeInvocation({ invocation: invocation({ server: s }), context: CONTEXT });

    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('validation');
    expect(outcome.evidence).toEqual([]);
    expect(structuredContentOf(outcome.response)).toBeUndefined();
    const text = isCallToolResponseResult(outcome.response) ? outcome.response.result.content[0] : undefined;
    expect(text?.type === 'text' ? text.text : '').toContain('missing_structured_content');
  });

  it('produces no evidence for a successful outcome with no declared output schema', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(structuredResponse({ ok: true, count: 5 }));
    const coordinator = coordinatorWithCapability(
      // Null schema but evidence_capabilities declared: must remain backward-compatible.
      capability({ output_schema: null, evidence_capabilities: ['test.passed'] }),
      s,
    );
    const outcome = await coordinator.executeInvocation({ invocation: invocation({ server: s }), context: CONTEXT });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.evidence).toEqual([]);
  });

  it('produces no evidence for a returned MCP domain error even under a declared output schema', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue({
      result: { content: [], isError: true, structuredContent: { ok: true, count: 1 } },
      wasInitialized: undefined,
    });
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, evidence_capabilities: ['test.passed'] }),
      s,
    );
    const outcome = await coordinator.executeInvocation({ invocation: invocation({ server: s }), context: CONTEXT });

    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('domain');
    expect(outcome.evidence).toEqual([]);
  });

  it('produces no evidence for an unknown tool (terminal invocation)', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ server: undefined, toolName: 'missing' }),
      context: CONTEXT,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('validation');
    expect(outcome.evidence).toEqual([]);
  });

  it('produces no evidence for a cancelled write', async () => {
    const s = server();
    const controller = new AbortController();
    jest.mocked(s.callTool).mockImplementation(() => {
      controller.abort('stop');
      return new Promise<CallToolResponse>(() => undefined);
    });
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, side_effect_class: 'remote_write', evidence_capabilities: ['x'] }),
      s,
    );
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ server: s, toolName: 'verify' }),
      context: { ...CONTEXT, signal: controller.signal },
    });
    expect(outcome.status).toBe('unknown');
    expect(outcome.failure_class).toBe('cancelled_after_dispatch');
    expect(outcome.evidence).toEqual([]);
  });

  it('records evidence on the lifecycle completed event and reconstructs it identically', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(structuredResponse({ ok: true, count: 9 }));
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, evidence_capabilities: ['test.passed', 'lint.clean'] }),
      s,
    );
    const events: ToolExecutionLifecycleEvent[] = [];
    await coordinator.executeInvocation({
      invocation: invocation({ server: s }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });
    const completed = events.find(e => e.type === EventType.TOOL_ATTEMPT_COMPLETED);
    if (completed?.type !== EventType.TOOL_ATTEMPT_COMPLETED) throw new Error('expected completion');
    // Reconstruct from the lifecycle event through the wire schema (round-trip JSON).
    const revived = ToolAttemptCompletedEventSchema.parse(JSON.parse(JSON.stringify(completed)));
    expect(revived.evidence).toHaveLength(2);
    expect(revived.evidence?.map(r => r.evidence_capability)).toEqual(['test.passed', 'lint.clean']);
    for (const record of revived.evidence ?? []) {
      expect(() => EvidenceRecordSchema.parse(record)).not.toThrow();
    }
  });

  it('defaults evidence to [] for a legacy completed event that omits the field', () => {
    const legacy = {
      session_id: 'session-1',
      turn_id: 'turn-1',
      thread_id: 'main',
      model_message_id: 'message-1',
      stable_tool_set_id: 'server',
      tool_name: 'verify',
      tool_call_id: 'call-1',
      root_tool_call_id: 'call-1',
      parent_tool_call_id: null,
      id: '00000000000000000000000000',
      created_at: new Date().toISOString(),
      attempt_id: '00000000-0000-4000-8000-000000000000',
      type: EventType.TOOL_ATTEMPT_COMPLETED,
      status: 'succeeded' as const,
      failure_class: null,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      argument_fingerprint: 'a'.repeat(64),
    };
    const parsed = ToolAttemptCompletedEventSchema.parse(legacy);
    expect(parsed.evidence).toEqual([]);
  });
});

// Local/nested/Code-Mode-style dispatch carries no durable session/turn identity. The schema/
// structured gate must still run (a prose-only "success" or a schema mismatch is a validation
// failure), while a valid structured result is verified evidence-free — identity is never fabricated.
describe('ToolExecutionCoordinator verification for identity-less calls', () => {
  const IDENTITY_LESS_CONTEXT: ToolExecutionContext = {
    session_id: null,
    turn_id: null,
    thread_id: 'nested',
    model_message_id: null,
    root_tool_call_id: null,
    parent_tool_call_id: 'parent-call',
    signal: undefined,
    event_recorder: undefined,
  };

  it('turns a schema mismatch into a validation failure with no evidence and no retry (no durable identity)', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(structuredResponse({ ok: 'nope', count: 5 }));
    const coordinator = coordinatorWithCapability(
      capability({
        output_schema: OUTPUT_SCHEMA,
        evidence_capabilities: ['test.passed'],
        side_effect_class: 'read_only',
        retry_capability: 'safe',
      }),
      s,
    );
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ server: s }),
      context: IDENTITY_LESS_CONTEXT,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('validation');
    expect(outcome.evidence).toEqual([]);
    expect(s.callTool).toHaveBeenCalledTimes(1);
    const text = isCallToolResponseResult(outcome.response) ? outcome.response.result.content[0] : undefined;
    expect(text?.type === 'text' ? text.text : '').toContain('output_schema_validation_failed');
  });

  it('treats prose-only success as a validation failure with no evidence (no durable identity)', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(toolResultResponse({ text: 'I promise the tests passed.' }));
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, evidence_capabilities: ['test.passed'] }),
      s,
    );
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ server: s }),
      context: IDENTITY_LESS_CONTEXT,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('validation');
    expect(outcome.evidence).toEqual([]);
    const text = isCallToolResponseResult(outcome.response) ? outcome.response.result.content[0] : undefined;
    expect(text?.type === 'text' ? text.text : '').toContain('missing_structured_content');
  });

  it('verifies valid structured output evidence-free without fabricating identity (no durable identity)', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(structuredResponse({ ok: true, count: 5 }));
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, evidence_capabilities: ['test.passed'] }),
      s,
    );
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ server: s }),
      context: IDENTITY_LESS_CONTEXT,
    });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.evidence).toEqual([]);
  });

  it('still mints evidence for a durable call under the same tool (regression guard)', async () => {
    const s = server();
    jest.mocked(s.callTool).mockResolvedValue(structuredResponse({ ok: true, count: 5 }));
    const coordinator = coordinatorWithCapability(
      capability({ output_schema: OUTPUT_SCHEMA, evidence_capabilities: ['test.passed'] }),
      s,
    );
    const outcome = await coordinator.executeInvocation({ invocation: invocation({ server: s }), context: CONTEXT });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.evidence).toHaveLength(1);
    expect(outcome.evidence[0]?.evidence_capability).toBe('test.passed');
    expect(outcome.evidence[0]?.source.attempt_id).toBe(outcome.attempt_id);
  });
});
