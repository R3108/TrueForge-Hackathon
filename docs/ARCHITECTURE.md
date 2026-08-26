# Architecture

## The shape of the system

```
        ┌──────────────┐
        │  Sentry      │  production errors
        └──────┬───────┘
               │ MCP (read-only)
               ▼
  ┌────────────────────────────┐        ┌──────────────────┐
  │   TrueForge server         │◄──────►│  Model provider  │
  │   · agent loop             │        │  (any, swappable)│
  │   · credentials            │        └──────────────────┘
  │   · approval enforcement   │
  └───┬──────────────────┬─────┘
      │                  │ MCP (writes gated)
      │ sandbox-as-tool  ▼
      │            ┌──────────────┐
      ▼            │   GitHub     │
┌─────────────┐    └──────────────┘
│  Sandbox    │           ▲
│  · repro    │           │ pull request
│  · tests    │           │
│  · NO creds │      ┌────┴─────┐
└─────────────┘      │   Qodo   │ automated review
                     └──────────┘
        ▲
        │ stream / approvals
  ┌─────┴──────────────────┐
  │  This repo (SDK client)│  provision · dispatch · doctor
  └────────────────────────┘
```

Three processes, clearly separated:

1. **The TrueForge server** runs the agent loop and holds every credential. It is the only component that talks to the model, the MCP servers, and the sandbox.
2. **The sandbox** executes code. It is provisioned on demand, holds no secrets, and is thrown away.
3. **This repository** is a thin SDK client. It defines the agent, opens sessions, renders the stream, and relays human decisions.

## Why the sandbox is a tool, not a home

Many harnesses run the whole agent *inside* a VM. TrueForge runs the loop on the server and treats the sandbox as one more tool it can call.

That choice is what makes the safety story work here. If the agent lived inside the sandbox, the GitHub token would have to live there too — and the untrusted code the agent writes in stage 3 would run next to it. Because the loop stays on the server, code execution and credential custody are in different places by construction, not by discipline.

It is also cheaper: stages 1–2 are pure reads and never provision a sandbox at all.

## Where the gate sits, and why there

The gate is on the **tool call**, not on the final answer.

Putting a human at the end — "here's a diff, ship it?" — sounds equivalent but isn't. By then the agent has already decided everything, and the human is rubber-stamping a summary written by the thing they're supposed to be checking. Gating the individual tool call means the human sees the *actual* `create_pull_request` arguments: the real branch, the real file contents, the real body. There is no gap between what is approved and what is executed.

TrueForge enforces this in the harness. The turn ends with a `tool.approval_required` event and the call does not run. It cannot be talked past by the model, because the model is not the thing enforcing it.

## Turn lifecycle

A repair is several turns, not one:

```
turn 1   user.message ──► read, reason, reproduce, patch
                          └─► tool.approval_required (create_branch)   ⏸ turn ends

turn 2   user.tool_approval {allow} ──► branch created, files pushed
                          └─► tool.approval_required (create_pull_request)   ⏸ turn ends

turn 3   user.tool_approval {allow} ──► PR opened ──► turn.done, nothing pending
```

`src/runtime/run.ts` drives this: stream a turn, collect whatever it paused on, resolve it with a human, open the next turn. It loops until a turn finishes with no pending actions, bounded by `MAX_RESUMES` so a pathological run cannot spin forever.

Turns chain automatically (`previous_turn_id` defaults to `auto`), so the agent keeps full context across the pauses without the client resending history.

## Failure modes we designed for

| Failure | Response |
| --- | --- |
| Agent can't reproduce the bug | Instructed to report it and stop, never to patch blind |
| Agent invents a passing test suite | Instructions forbid it; the sandbox output is in the trace for a human to check |
| Nobody is at the terminal | `approvals.ts` denies every pending write — fails closed |
| Runaway agent loop | `iteration_limit: 120` in the spec; `MAX_RESUMES` in the client |
| Connector unauthorized mid-demo | `npm run doctor` catches it before you start |
| Oversized tool output floods context | Harness large-response offloading writes it to a sandbox file |
| An event type we've never seen | The renderer tolerates unknown types rather than crashing the run |

## Deliberate limitations

- **One repository per deployment.** `LTP_TARGET_REPO` is a single repo by design. A multi-repo agent needs a permission model this hackathon build doesn't have.
- **Sentry is the only incident source.** The playbook generalizes to any error tracker with an MCP server; only Sentry is wired.
- **The gate is per-call, so a large fix means several prompts.** That is the intended trade. Batching approvals would put distance back between what is approved and what runs.
