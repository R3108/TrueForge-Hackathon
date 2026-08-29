import type { ApprovalBinding } from '../../../src/core/events/schema';
import { canonicalArgumentFingerprint } from '../../../src/core/mcp/canonicalArguments';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
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

const POLICY_VERSION = 'policy-v1';

function boundServer(toolName: string, policyVersion: string = POLICY_VERSION): IToolSet {
  const server = makeMockIMCPServer({ name: 'server', preload: true, policyVersion });
  jest
    .mocked(server.callTool)
    .mockImplementation(params => Promise.resolve(toolResultResponse({ text: `${params.name}:ok` })));
  jest.mocked(server.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: 'server',
    mcp_server_name: 'server',
    original_tool_name: toolName,
    is_approval_required: true,
  });
  return server;
}

function expectedBinding(input: {
  toolName: string;
  toolCallId: string;
  args: unknown;
  policyVersion?: string;
}): ApprovalBinding {
  return {
    version: 1,
    thread_id: 'main',
    model_message_id: 'message-1',
    tool_call_id: input.toolCallId,
    stable_tool_set_id: 'server',
    original_tool_name: input.toolName,
    argument_fingerprint: canonicalArgumentFingerprint(input.args),
    policy: { policy_id: 'server', policy_version: input.policyVersion ?? POLICY_VERSION },
  };
}

function allowInvocation(input: {
  server: IToolSet | undefined;
  toolName: string;
  toolCallId: string;
  args: string;
  binding: ApprovalBinding | undefined;
}): ToolExecutionInvocation {
  return {
    tool_call_id: input.toolCallId,
    tool_set: input.server,
    tool_name: input.toolName,
    arguments: input.args,
    approval_decision: { status: 'allow' },
    approval_binding: input.binding,
    model_message_id: 'message-1',
  };
}

function textOf(response: Awaited<ReturnType<IToolSet['callTool']>>): string {
  if (!isCallToolResponseResult(response)) {
    return '';
  }
  const first = response.result.content[0];
  return first?.type === 'text' ? first.text : '';
}

describe('ToolExecutionCoordinator approval binding', () => {
  it('dispatches an approved call whose binding exactly matches live identity, policy, and arguments', async () => {
    const server = boundServer('write');
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: allowInvocation({
        server,
        toolName: 'write',
        toolCallId: 'call-1',
        args: '{"path":"a"}',
        binding: expectedBinding({ toolName: 'write', toolCallId: 'call-1', args: { path: 'a' } }),
      }),
      context: CONTEXT,
    });

    expect(outcome.status).toBe('succeeded');
    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(textOf(outcome.response)).toBe('write:ok');
  });

  it('fails closed when the approved arguments differ from the bound fingerprint', async () => {
    const server = boundServer('write');
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      // Binding was granted for {path:'a'} but the call now carries {path:'b'}.
      invocation: allowInvocation({
        server,
        toolName: 'write',
        toolCallId: 'call-1',
        args: '{"path":"b"}',
        binding: expectedBinding({ toolName: 'write', toolCallId: 'call-1', args: { path: 'a' } }),
      }),
      context: CONTEXT,
    });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_mismatch');
  });

  it('fails closed when the live tool-set identity no longer matches the bound tool set', async () => {
    // Binding was minted against stable_tool_set_id 'server'; the live tool set is now 'other-server'.
    const server = makeMockIMCPServer({ name: 'other-server', preload: true, policyVersion: POLICY_VERSION });
    jest.mocked(server.callTool).mockResolvedValue(toolResultResponse({ text: 'ok' }));
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: allowInvocation({
        server,
        toolName: 'write',
        toolCallId: 'call-1',
        args: '{"path":"a"}',
        binding: expectedBinding({ toolName: 'write', toolCallId: 'call-1', args: { path: 'a' } }),
      }),
      context: CONTEXT,
    });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_mismatch');
  });

  it('fails closed when the governing policy version advanced after approval', async () => {
    // Live policy is now 'policy-v2'; the binding was minted under 'policy-v1'.
    const server = boundServer('write', 'policy-v2');
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: allowInvocation({
        server,
        toolName: 'write',
        toolCallId: 'call-1',
        args: '{"path":"a"}',
        binding: expectedBinding({
          toolName: 'write',
          toolCallId: 'call-1',
          args: { path: 'a' },
          policyVersion: 'policy-v1',
        }),
      }),
      context: CONTEXT,
    });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_mismatch');
  });

  it('fails closed when a supplied binding mismatches on a non-argument field', async () => {
    const server = boundServer('write');
    const coordinator = new ToolExecutionCoordinator();
    const tampered = {
      ...expectedBinding({ toolName: 'write', toolCallId: 'call-1', args: { path: 'a' } }),
      original_tool_name: 'delete',
    };
    const outcome = await coordinator.executeInvocation({
      invocation: allowInvocation({
        server,
        toolName: 'write',
        toolCallId: 'call-1',
        args: '{"path":"a"}',
        binding: tampered,
      }),
      context: CONTEXT,
    });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_mismatch');
  });

  it('fails a legacy persisted allow decision without any binding closed', async () => {
    const server = boundServer('write');
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: allowInvocation({
        server,
        toolName: 'write',
        toolCallId: 'call-1',
        args: '{"path":"a"}',
        binding: undefined,
      }),
      context: CONTEXT,
    });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_missing');
  });

  it('keeps a denial terminal even when no binding is present', async () => {
    const server = boundServer('write');
    // A deny decision routes through the tool set preflight, which returns the terminal deny result.
    server.prepareToolCall = jest.fn().mockImplementation((_params, decision) => {
      expect(decision).toEqual({ status: 'deny', reason: 'not allowed' });
      return Promise.resolve({
        kind: 'resolved',
        response: toolResultResponse({
          text: JSON.stringify({ error: 'User denied tool call: not allowed' }),
          isError: true,
        }),
      });
    });
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: {
        tool_call_id: 'call-1',
        tool_set: server,
        tool_name: 'write',
        arguments: '{"path":"a"}',
        approval_decision: { status: 'deny', reason: 'not allowed' },
        approval_binding: undefined,
        model_message_id: 'message-1',
      },
      context: CONTEXT,
    });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('domain');
    expect(textOf(outcome.response)).toContain('User denied tool call');
  });

  it('does not gate nested/Code Mode dispatch on a binding it never carried', async () => {
    // A nested call inherits the approved parent's trust: parent_tool_call_id is non-null and no
    // binding is supplied, yet the allow decision must still dispatch.
    const server = boundServer('inner');
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: {
        tool_call_id: 'nested:root:1',
        tool_set: server,
        tool_name: 'inner',
        arguments: '{"path":"a"}',
        approval_decision: { status: 'allow' },
        approval_binding: undefined,
        model_message_id: 'message-1',
      },
      context: { ...CONTEXT, root_tool_call_id: 'root', parent_tool_call_id: 'root' },
    });

    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('succeeded');
  });
});
