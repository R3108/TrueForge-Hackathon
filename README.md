# Licence to Patch

**An on-call agent that reads a production error, reproduces it in a sandbox, writes a fix, and opens a pull request — and cannot touch your repository without a human saying yes.**

Built on [TrueForge](https://github.com/truefoundry/trueforge), the open-source agent harness, for the TrueForge Agent Harness Hackathon.

---

## The problem

At 3am, an alert fires. The stack trace is right there. The fix is probably four lines. But someone still has to wake up, read the trace, find the file, reproduce the failure, write a test, patch it, and open a PR.

Existing "AI fixes your bug" tools fail in one of two directions. Either they're a chat window that suggests a patch and leaves you to do the work — or they're an autonomous bot that pushes to your repo while you sleep, and you find out what it decided in the morning.

**Licence to Patch takes the third path: full autonomy up to the repository boundary, and a hard stop at it.** The agent reads, reasons, reproduces, and tests entirely on its own. The moment it wants to write to your repo, it stops and shows you exactly what it intends to do.

## The six standing orders

The agent works a fixed playbook. It cannot skip a stage, and it cannot reach stage 6 without a person.

```
  Sentry alert
       │
       ▼
  ┌─────────────────────────────────────────────────┐
  │ 1  READ THE BRIEF     sentry MCP  · autonomous  │
  │    exception, stack trace, blast radius         │
  ├─────────────────────────────────────────────────┤
  │ 2  CASE THE BUILDING  github MCP  · autonomous  │
  │    read the real source at the culprit frame    │
  ├─────────────────────────────────────────────────┤
  │ 3  REPRODUCE IT       SANDBOX     · autonomous  │
  │    write a FAILING test that captures the bug   │
  ├─────────────────────────────────────────────────┤
  │ 4  MAKE THE FIX       SANDBOX     · autonomous  │
  │    smallest change that goes red → green        │
  ├─────────────────────────────────────────────────┤
  │ 5  REQUEST CLEARANCE  ⏸  HUMAN APPROVAL GATE    │
  │    root cause + diff + test evidence, then wait │
  ├─────────────────────────────────────────────────┤
  │ 6  FILE THE REPORT    github MCP  · gated       │
  │    one PR, with a how-to-verify section         │
  └─────────────────────────────────────────────────┘
       │
       ▼
  Qodo reviews the PR
```

Stage 3 is the one that matters. An agent that skips reproduction produces plausible patches; an agent that must show you a red test going green produces real ones. If it cannot reproduce the failure, it is instructed to say so and stop — a truthful "I couldn't reproduce this" beats a confident wrong patch.

## Why the approval gate is the whole project

Anyone can wire an LLM to the GitHub API. The engineering is in what happens *before* the write.

Every repository-mutating tool is named explicitly in the agent spec and gated:

```ts
// src/agent/spec.ts
{
  name: config.connectors.github,
  enableTools: ['@all'],
  requireApprovalForTools: [
    'create_branch',      'create_or_update_file', 'push_files',
    'delete_file',        'create_pull_request',   'update_pull_request',
    'merge_pull_request', 'create_issue',          'update_issue',
    'add_issue_comment',
  ],
}
```

Reads run free. Writes stop dead. Three properties follow:



- **Secrets never reach the sandbox.** TrueForge runs the sandbox *as a tool*, not as the agent's home — the loop and its credentials stay on the server. Code the agent writes executes in an isolated environment that has never seen your GitHub token.
- **Denial is a real outcome.** Deny a call and the agent receives your reason, explains what it would need to proceed, and stops. It does not retry around you.
- **It fails closed.** No TTY — CI, a piped stdin, an unattended run — and every pending write is denied automatically. The unsafe direction is never the default.

## The write perimeter

There is a hole in the design above, and closing it is the second half of this project.

`LTP_TARGET_REPO` is **repo-granular**. Once the agent may write to a repository, the harness will let it write anywhere in that repository. The service it repairs, [`fixture/`](fixture/), lives in this same repository — so without a further control, the agent could open a pull request that edits `src/agent/spec.ts` and removes its own approval gate. A tired operator at 3am would see a normal-looking approval prompt.

So the boundary is declared in code:

```
LTP_WRITE_PATHS=fixture/**
```

Any write touching a path outside the perimeter is **denied before a human is asked**. Not shown in red, not prompted with a warning — never offered:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  BLOCKED BY WRITE PERIMETER
  Denied automatically. No approval was offered.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  create_or_update_file
        outside    src/agent/spec.ts
        perimeter  fixture/**
```

The agent receives the denial and the reason, and can explain what it would need — it simply cannot get there. Path traversal is resolved before matching, so `fixture/../src/agent/spec.ts` is outside the perimeter too; a boundary you can walk out of with `../` is not a boundary. A multi-file push is rejected whole if any single file escapes.

**What this is not.** The perimeter is enforced in the dispatch client, so it governs `npm run dispatch`. Someone driving the same agent from the TrueForge chat UI gets the harness's repository-level gate and nothing more. It is a real control on the real operating path, not a sandbox escape-proof boundary, and it is worth being precise about which of those you are being sold.

See [`src/runtime/perimeter.ts`](src/runtime/perimeter.ts) and its tests.

## What TrueForge is doing here

This is not a model in a `while` loop with `fetch` calls bolted on. The harness is load-bearing:

| Harness capability | What it does for this agent |
| --- | --- |
| **Sandbox as a tool** | Stage 3–4 run the repro and the test suite in isolation, provisioned only when needed |
| **Tool approval** | The stage-5 gate — per-tool, declared in the spec, enforced by the harness |
| **MCP connectors** | Sentry (read-only) and GitHub, with credentials in the connector, never in the repo |
| **Deferred tool loading** | GitHub's large tool surface loads on demand, keeping context lean for reasoning |
| **Subagents** | Reading several call sites fans out in parallel, merging only conclusions |
| **Compaction + offloading** | A long repair run doesn't drown in stack traces and file dumps |
| **Ask clarifying questions** | Two plausible root causes → it asks instead of guessing |
| **Generative UI** | Incident card, files-touched table, before/after test panel, rendered in chat |

Swap `LTP_MODEL` and the same agent runs on a different provider — TrueForge is vendor-neutral, and so is this.

## Quick start

**Requires Node 22.14+.**

```bash
# 1. Start TrueForge (separate terminal) — UI at http://localhost:8790
npx @truefoundry/trueforge@latest

# 2. In the TrueForge UI:
#      Settings → Models      → add a provider + API key
#      Settings → Connectors  → add "sentry" and "github"
#      Settings → Sandbox     → configure a sandbox provider

# 3. Configure and provision
cp .env.example .env      # fill in model, target repo, connector names
npm install
npm run doctor            # pre-flight: node version, server, agent
npm run provision         # creates the agent from src/agent/spec.ts

# 4. Dispatch an incident
npm run dispatch -- PROJECT-4A2
```

`npm run doctor` exists because the worst time to discover an unauthorized connector is halfway through a demo.

## Repository layout

```
src/
  config.ts            env → typed config (names and URLs only, never secrets)
  client.ts            TrueForge client, with a timeout a real repair survives
  agent/spec.ts        THE AGENT — instructions, tools, approval gate, sandbox
  agent/registry.ts    look up a saved agent by name
  runtime/run.ts       stream a turn, collect pauses, resume until settled
  runtime/approvals.ts the human gate; fails closed without a TTY
  runtime/perimeter.ts the write perimeter; denies before a human is asked
  runtime/render.ts    terminal rendering, and what a write actually touches
  cli/provision.ts     create/update the saved agent from the spec
  cli/dispatch.ts      run one incident end to end
  cli/doctor.ts        pre-flight checks
fixture/               the service under repair — the only place the agent may write
docs/
  ARCHITECTURE.md      how the pieces fit, and why the gate sits where it does
  DEMO.md              the three-minute demo script
```

The agent lives in **one reviewable file**. `src/agent/spec.ts` is the entire definition — instructions, tool filters, approval policy, sandbox, context management. Nothing is hand-clicked in a UI and lost; `npm run provision` makes the server match the repo.

## Code review

Every substantive change lands through a pull request reviewed by **[Qodo](https://www.qodo.ai/)**. No direct commits to `main`.

<!-- TODO(before submission): link the representative merged PR here. -->

## Safety and scope

- The agent only ever writes to the single repository named in `LTP_TARGET_REPO`.
- Sentry is attached read-only (`enableTools: ['@read-only']`) — incidents are read, never mutated.
- Credentials live in TrueForge connectors. This repository contains no tokens, and `.env` is git-ignored.
- One PR per incident, always branched off the base branch, never pushed to it.

## License

MIT — see [LICENSE](LICENSE).
