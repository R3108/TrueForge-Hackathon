import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { style, preview, summarizeInline } from './render.ts';
import { requestClearance, type ClearanceOptions, type PendingCall } from './approvals.ts';

/**
 * Anything the harness streams. The SDK ships precise per-event types, but the
 * renderer only needs a handful of fields and benefits from tolerating event
 * types it has never seen - a new event kind should not crash an incident run.
 */
interface StreamEvent {
  type: string;
  id?: string;
  thread_id?: string | null;
  content?: string | null;
  [key: string]: unknown;
}

type TurnInput = TrueForgeApi.TurnInputItem;

const MAX_RESUMES = 40;

/**
 * Drive one incident to completion.
 *
 * A turn ends whenever the agent needs a human: an approval on a gated tool, or
 * an answer to a clarifying question. We render the stream, collect whatever it
 * paused on, resolve it, and open the next turn - until the agent finishes with
 * nothing pending.
 */
export async function runIncident(
  client: TrueForge,
  sessionId: string,
  brief: string,
  clearance: ClearanceOptions = {},
): Promise<{ turns: number; finalOutput: string }> {
  let input: TurnInput[] = [{ type: 'user.message', content: brief }];
  let turns = 0;
  let finalOutput = '';

  for (let resume = 0; resume <= MAX_RESUMES; resume++) {
    turns++;
    const { pending, output, status } = await streamTurn(client, sessionId, input);
    if (output) finalOutput = output;

    if (pending.length === 0) {
      console.log(`\n${style.dim(`Turn finished with status: ${status}`)}`);
      return { turns, finalOutput };
    }

    const decisions = await requestClearance(pending, clearance);
    input = decisions;
  }

  throw new Error(
    `Incident did not settle after ${MAX_RESUMES} approval rounds - stopping to avoid a loop.`,
  );
}

async function streamTurn(
  client: TrueForge,
  sessionId: string,
  input: TurnInput[],
): Promise<{ pending: PendingCall[]; output: string; status: string }> {
  const stream = await client.sessions.createTurnStream(sessionId, { input });

  /** model.message events by id, so an approval can name the tool it belongs to. */
  const eventsById = new Map<string, StreamEvent>();
  const pendingEvents: StreamEvent[] = [];
  const openThreads = new Set<string>();

  let streamingText = false;
  let output = '';
  let status = 'unknown';

  const endText = () => {
    if (streamingText) {
      process.stdout.write('\n');
      streamingText = false;
    }
  };

  for await (const { data } of stream.withMetadata()) {
    const event = data as unknown as StreamEvent;
    if (event.id) eventsById.set(event.id, event);

    switch (event.type) {
      case 'turn.created':
        console.log(style.dim(`\n· turn started`));
        break;

      case 'mcp.initialize': {
        const names = mcpServersOf(event).map(labelOf);
        console.log(style.dim(`· connected to ${names.join(', ') || 'an MCP server'}`));
        break;
      }

      case 'mcp.auth_required': {
        endText();
        const servers = mcpServersOf(event);
        if (servers.length === 0) {
          console.log(style.yellow('· a connector needs authorization'));
        }
        for (const server of servers) {
          console.log(style.yellow(`· connector ${style.bold(labelOf(server))} needs authorization`));
          const url = server.auth_url ?? server.authUrl;
          if (url) console.log(style.yellow(`  authorize: ${url}`));
        }
        break;
      }

      case 'thread.created': {
        const id = String(event.id ?? event.thread_id ?? '');
        if (id && id !== 'main' && !openThreads.has(id)) {
          openThreads.add(id);
          endText();
          console.log(style.blue(`· subagent started (${id.slice(0, 8)})`));
        }
        break;
      }

      case 'thread.done': {
        const id = String(event.id ?? event.thread_id ?? '');
        if (openThreads.delete(id)) {
          endText();
          console.log(style.blue(`· subagent finished (${id.slice(0, 8)})`));
        }
        break;
      }

      case 'model.message': {
        // Every call in the message, not just the first - a message that asks
        // for three writes should print three lines.
        const calls = allToolCalls(event);
        if (calls.length > 0) endText();
        for (const call of calls) {
          console.log(`${style.cyan('· tool')} ${summarizeInline(call.name, call.args)}`);
        }
        break;
      }

      case 'model.message.delta':
        if (event.content) {
          streamingText = true;
          process.stdout.write(event.content);
        }
        break;

      case 'tool.response':
        endText();
        console.log(style.dim(`  ↳ ${preview(event.content ?? event.output, 240)}`));
        break;

      case 'tool.approval_required':
      case 'tool.response_required':
        endText();
        pendingEvents.push(event);
        break;

      case 'turn.done': {
        endText();
        const state = (event.state ?? {}) as {
          status?: string;
          output?: { content?: string } | null;
          required_actions?: StreamEvent[];
        };
        status = state.status ?? 'unknown';
        output = state.output?.content ?? '';
        for (const action of state.required_actions ?? []) {
          if (!pendingEvents.some((p) => sameCall(p, action))) pendingEvents.push(action);
        }
        break;
      }

      default:
        break;
    }
  }

  endText();
  return { pending: pendingEvents.map((e) => resolvePending(e, eventsById)), output, status };
}

function sameCall(a: StreamEvent, b: StreamEvent): boolean {
  return callId(a) !== undefined && callId(a) === callId(b);
}

interface McpServerRef {
  name?: string;
  id?: string;
  auth_url?: string;
  authUrl?: string;
}

/**
 * `mcp.*` events carry an `mcp_servers` array - `[{ id, name, auth_url }]` - not
 * a scalar server name. The `auth_url` is the whole point of an auth_required
 * event: it is the link that unblocks the connector.
 */
function mcpServersOf(event: StreamEvent): McpServerRef[] {
  const servers = event.mcp_servers ?? event.mcpServers;
  return Array.isArray(servers) ? (servers as McpServerRef[]) : [];
}

function labelOf(server: McpServerRef): string {
  return server.name ?? server.id ?? '(unnamed)';
}

function callId(event: StreamEvent): string | undefined {
  const id = event.tool_call_id ?? event.toolCallId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Turn a pause event into something worth showing a human: the pause itself only
 * carries ids, so the tool's name and arguments come from the `model.message`
 * that requested it.
 *
 * One model message can carry several tool calls, and each gets its own pause.
 * The call is therefore looked up **by `tool_call_id`** - taking the first call
 * in the message would let an in-perimeter path be checked and displayed while
 * the approval is routed to a different, unchecked write. That is not a display
 * bug: it defeats the perimeter, the tripwire, and the operator all at once.
 *
 * When the id cannot be matched, the call is marked unresolved rather than
 * guessed at. Nothing downstream can inspect arguments it does not have, so the
 * gate refuses it.
 */
function resolvePending(event: StreamEvent, index: Map<string, StreamEvent>): PendingCall {
  const sourceId = event.source_event_id ?? event.sourceEventId;
  const source = typeof sourceId === 'string' ? index.get(sourceId) : undefined;
  const wantedId = callId(event);
  const call = source && wantedId ? toolCallOf(source, wantedId) : undefined;

  // `arguments` on the pause event itself is authoritative when present.
  const inlineArgs = parseArgs(event.arguments);
  const args = call?.args ?? inlineArgs;

  return {
    threadId: String(event.thread_id ?? 'main'),
    toolCallId: wantedId ?? '',
    toolName: call?.name ?? str(event.tool_name) ?? 'unknown tool',
    args: args ?? {},
    resolved: call !== undefined || inlineArgs !== undefined,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Tool-call ids live in different places across shapes; check all of them. */
function idOfCall(call: Record<string, unknown>): string | undefined {
  const id = call.id ?? call.tool_call_id ?? call.toolCallId;
  return typeof id === 'string' ? id : undefined;
}

function parseArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Pull one specific tool call out of a model.message, tolerating shape drift.
 *
 * Deliberately returns undefined when `wantedId` matches nothing: a fallback to
 * "some other call in the same message" is exactly the confusion this exists to
 * prevent.
 */
function toolCallOf(
  event: StreamEvent,
  wantedId: string,
): { name: string; args: unknown } | undefined {
  const calls = event.tool_calls ?? event.toolCalls;
  if (!Array.isArray(calls)) return undefined;

  const match = (calls as Array<Record<string, unknown>>).find(
    (call) => idOfCall(call) === wantedId,
  );
  return match ? readCall(match) : undefined;
}

/** Every tool call in a model.message, in order, for live rendering. */
function allToolCalls(event: StreamEvent): Array<{ name: string; args: unknown }> {
  const calls = event.tool_calls ?? event.toolCalls;
  if (!Array.isArray(calls)) return [];

  return (calls as Array<Record<string, unknown>>)
    .map(readCall)
    .filter((call): call is { name: string; args: unknown } => call !== undefined);
}

function readCall(call: Record<string, unknown>): { name: string; args: unknown } | undefined {
  const fn = (call.function ?? call) as Record<string, unknown>;
  const name = fn.name;
  if (typeof name !== 'string') return undefined;

  return { name, args: parseArgs(fn.arguments ?? fn.args) };
}
