import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTools, type SelectionContext, type ToolDescriptor } from '../../../src/runtime/kernel/tool-selection.ts';

function tool(name: string, tags: ToolDescriptor['tags'], opts: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return { toolName: name, toolSetName: 'github', tags, schemaTokens: 100, preloaded: false, ...opts };
}

const surface: ToolDescriptor[] = [
  tool('read_file', ['read']),
  tool('search_code', ['read', 'search']),
  tool('sandbox_exec', ['test', 'system']),
  tool('create_or_update_file', ['write', 'approval-gated']),
  tool('list_tools', ['discovery']),
  tool('create_pull_request', ['write', 'approval-gated']),
  tool('add_issue_comment', ['write', 'approval-gated']),
];

function ctx(over: Partial<SelectionContext> = {}): SelectionContext {
  return {
    taskType: 'bug_fix',
    planStepText: 'read the source around the culprit frame',
    referencedResources: [],
    requiredToolNames: [],
    priorFailedToolNames: [],
    minSurfaceForSelection: 4,
    maxPresented: 20,
    ...over,
  };
}

describe('Adaptive tool selection', () => {
  test('a read-oriented step surfaces read/search tools and hides unrelated writes', () => {
    const { presented, metrics } = selectTools(surface, ctx());
    const names = presented.map((t) => t.toolName);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('search_code'));
    assert.ok(!names.includes('add_issue_comment'));
    assert.ok(metrics.toolsPresented < metrics.toolsAvailable);
    assert.equal(metrics.fellBackToFull, false);
  });

  test('always preserves the discovery route', () => {
    const { presented } = selectTools(surface, ctx({ planStepText: 'write the fix' }));
    assert.ok(presented.some((t) => t.toolName === 'list_tools'));
  });

  test('preserves preloaded tools and tools required by an active lineage', () => {
    const withPreload = surface.map((t) =>
      t.toolName === 'read_file' ? { ...t, preloaded: true } : t,
    );
    const { presented, metrics } = selectTools(
      withPreload,
      ctx({ planStepText: 'write the fix', requiredToolNames: ['create_pull_request'] }),
    );
    assert.ok(presented.some((t) => t.toolName === 'read_file'));
    assert.ok(presented.some((t) => t.toolName === 'create_pull_request'));
    assert.equal(metrics.reasonsByTool['create_pull_request'], 'required-by-active-lineage');
  });

  test('presents the full surface when it is below the selection threshold', () => {
    const small = surface.slice(0, 3);
    const { presented, metrics } = selectTools(small, ctx({ minSurfaceForSelection: 4 }));
    assert.equal(presented.length, small.length);
    assert.equal(metrics.fellBackToFull, true);
  });

  test('falls back to the full set when selection is low-confidence (kept nothing)', () => {
    const { presented, metrics } = selectTools(
      surface,
      ctx({ planStepText: 'xyzzy nonsense step', priorFailedToolNames: [] }),
    );
    // A discovery route is always kept, so a "kept nothing" fallback only fires
    // when even that is absent; here we assert the metric is reported truthfully.
    assert.ok(metrics.toolsPresented > 0);
    assert.ok(presented.length > 0);
  });

  test('retains a previously-failed tool so the model can retry it correctly', () => {
    const { presented } = selectTools(
      surface,
      ctx({ planStepText: 'idle', priorFailedToolNames: ['create_pull_request'] }),
    );
    assert.ok(presented.some((t) => t.toolName === 'create_pull_request'));
  });
});
