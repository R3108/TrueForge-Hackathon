import { z } from 'zod';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import { validateAgainstInputSchema } from '../../../src/core/mcp/inputSchemaValidator';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

class SampleLocalTool extends LocalToolMCP {
  readonly name = 'sample';
  readonly displayName = 'Sample';

  constructor() {
    super({ tracing: NOOP_AGENT_TRACING });
  }

  protected getTools(): ToolDefinition[] {
    return [
      defineTool({
        name: 'greet',
        description: 'greets',
        schema: z.object({ name: z.string(), times: z.number().default(1) }),
        handler: () => Promise.resolve(toolResultResponse({ text: 'ok' })),
      }),
    ];
  }
}

describe('LocalToolMCP.getToolInputSchema', () => {
  it('returns the canonical defineTool-generated schema advertised by listTools', async () => {
    const tool = new SampleLocalTool();
    const schema = tool.getToolInputSchema('greet');
    expect(schema).toBeDefined();
    const listed = await tool.listTools();
    expect(schema).toEqual(listed.result.tools[0]?.inputSchema);
  });

  it('returns undefined for an unknown tool', () => {
    const tool = new SampleLocalTool();
    expect(tool.getToolInputSchema('missing')).toBeUndefined();
  });

  it('produces a schema the coordinator validator can enforce', () => {
    const tool = new SampleLocalTool();
    const schema = tool.getToolInputSchema('greet');
    // `name` is required by the canonical schema; a missing/invalid value is a known violation.
    expect(validateAgainstInputSchema({ name: 'ada' }, schema).ok).toBe(true);
    expect(validateAgainstInputSchema({ name: 5 }, schema).ok).toBe(false);
  });
});
