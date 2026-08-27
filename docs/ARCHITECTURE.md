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
| Operator walks away mid-prompt | Ctrl-C denies the write in front of them and every one behind it |
| Agent tries to patch its own gate | `perimeter.ts` refuses it before a human is asked |
| Agent pastes a token into the patch | `secrets.ts` refuses the payload before a human is asked |
| Someone widens the perimeter in a PR | CI asserts the control plane is unreachable; the PR fails |
| Someone edits the agent in the UI | `npm run doctor` compares the server's gate against the repo's spec |
| Runaway agent loop | `iteration_limit: 120` in the spec; `MAX_RESUMES` in the client |
| Connector unauthorized mid-demo | `npm run doctor` catches it before you start |
| Oversized tool output floods context | Harness large-response offloading writes it to a sandbox file |
| An event type we've never seen | The renderer tolerates unknown types rather than crashing the run |
| "What did it actually do?" after the fact | `journal.ts` — a hash-chained record of every decision, verifiable later |

## Three checks, in the order they run

A gated tool call passes through three things before anyone is asked, and the order is the design:

```
tool.approval_required
        │
        ▼
  1  write perimeter    where?   ── outside ──►  DENIED, no human asked
        │ inside
        ▼
  2  credential tripwire what?   ── found ────►  DENIED, no human asked
        │ clean
        ▼
  3  the human           should we?            ── no TTY / Ctrl-C ──► DENIED
        │
        ▼
     approved  ──►  the call runs

  every outcome above ──►  appended to the decision journal
```

The first two refuse rather than warn. That is the whole argument: a boundary an operator can be walked through at 3am is a boundary that will be walked through at 3am, and the two questions those stages answer — *is this file mine to write?* and *is this payload a credential?* — are exactly the two a tired human is worst at. The third question, *is this the right fix?*, is the one only a person can answer, and it is the only one they are asked.

## Deliberate limitations

- **One repository per deployment.** `LTP_TARGET_REPO` is a single repo by design. A multi-repo agent needs a permission model this hackathon build doesn't have.
- **Sentry is the only incident source.** The playbook generalizes to any error tracker with an MCP server; only Sentry is wired.
- **The gate is per-call, so a large fix means several prompts.** That is the intended trade. Batching approvals would put distance back between what is approved and what runs.
- **The perimeter and the tripwire live in the client, not the harness.** They govern `npm run dispatch`, which is the operating path — but they are not properties of the agent itself. See [SECURITY.md](../SECURITY.md) for what that does and does not buy you.
- **The journal proves integrity, not identity.** It detects an edited or reordered record; it does not attest to who was at the keyboard. Signing it would need a key, and a key would need somewhere safe to live.
