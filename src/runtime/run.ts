import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { style, preview } from './render.ts';
import { requestClearance, type Decision, type PendingCall } from './approvals.ts';

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

type TurnInput = { type: 'user.message'; content: string } | Decision;

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

    const decisions = await requestClearance(pending);
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
  const stream = await client.sessions.createTurnStream(sessionId, { input: input as never });

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

      case 'mcp.initialize':
        console.log(style.dim(`· connected to ${String(event.server_name ?? 'an MCP server')}`));
        break;

      case 'mcp.auth_required':
        endText();
        console.log(
          style.yellow(
            `· connector ${String(event.server_name ?? '')} needs authorization - open the TrueForge chat UI to connect it`,
          ),
        );
        break;

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
        const call = toolCallOf(event);
        if (call) {
          endText();
          console.log(`${style.cyan('· tool')} ${style.bold(call.name)}`);
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

function callId(event: StreamEvent): string | undefined {
  const id = event.tool_call_id ?? event.toolCallId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Turn a pause event into something worth showing a human: the pause itself only
 * carries ids, so the tool's name and arguments come from the `model.message`
 * that requested it.
 */
function resolvePending(event: StreamEvent, index: Map<string, StreamEvent>): PendingCall {
  const sourceId = event.source_event_id ?? event.sourceEventId;
  const source = typeof sourceId === 'string' ? index.get(sourceId) : undefined;
  const call = source ? toolCallOf(source) : undefined;

  return {
    threadId: String(event.thread_id ?? 'main'),
    toolCallId: callId(event) ?? '',
    toolName: call?.name ?? 'unknown tool',
    args: call?.args ?? event.arguments ?? {},
  };
}

/** Pull the first tool call out of a model.message, tolerating shape drift. */
function toolCallOf(event: StreamEvent): { name: string; args: unknown } | undefined {
  const calls = event.tool_calls ?? event.toolCalls;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;

  const first = calls[0] as Record<string, unknown>;
  const fn = (first.function ?? first) as Record<string, unknown>;
  const name = fn.name;
  if (typeof name !== 'string') return undefined;

  const rawArgs = fn.arguments ?? fn.args;
  let args: unknown = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = rawArgs;
    }
  }
  return { name, args };
}
