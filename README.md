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

## Verified self-healing firewall

The repository perimeter is now one rule in a typed gate, not the whole control. At the SDK required-action boundary the runtime:

- resolves every `toolCalls[]` reference by source event and exact call ID (including parallel call B);
- keeps approval actions and client-response actions as different protocol types;
- binds GitHub policy to the configured MCP server name and stable server ID, then checks exact repository, repository-relative paths, allowlisted paths, secret paths, protected branches, destructive tools, and known required fields;
- returns bounded structured repair feedback without mutating or replaying the original call;
- binds one-shot approval to session, turn, thread, call ID, HMAC argument fingerprint, and policy version;
- invalidates test evidence whenever the observed workspace/repository epoch advances; and
- closes only on explicit terminal `done`, never on failed or cancelled turns.

The configured boundary remains:

```text
LTP_TARGET_REPO=R3108/TrueForge-Hackathon
LTP_BASE_BRANCH=main
LTP_WRITE_PATHS=fixture/**
LTP_EXECUTION_TOOL_ID=<stable host tool-set id>
LTP_EXECUTION_TOOL_NAME=<stable host tool-set name>
```

A wrong repository, traversal, absolute path, secret path, protected-base write, destructive operation, or unknown approval-gated tool is denied before a human is asked. A deterministic missing-field failure receives JSON feedback and must return as a new call ID. A repeated invalid fingerprint or exhausted two-attempt budget opens the circuit.

The final checkpoint shows policy, repository/branch/path, call fingerprint, repair budget, historical regression evidence, current-epoch targeted/full-suite evidence, and whether success text lacked structured execution facts. The evidence informs approval; it never replaces TrueForge's required human decision.

Run the complete proof without external services:

```powershell
npm run demo:firewall
```

Measure the same guarantees as machine-readable evidence — a deterministic,
no-network harness that exercises the real `ToolCallGate`, `EvidenceLedger`, and
protocol resolvers, emits one JSON report plus a compact table, and exits
non-zero when any safety gate or the coordinator latency gate (p95 < 100 ms of
pure gate CPU, excluding tool latency) fails:

```powershell
npm run bench
```

It reports paired fixtures — baseline vs coordinator latency, invalid calls
blocked before dispatch, typed evidence vs fake prose, safe parallel reads,
conflicting-write serialization, terminal denial, ambiguous-write disposition,
restart classification, and adaptive stop vs naive repeated calls — with
distributions, counts, and environment metadata. End-to-end model repair quality
is out of scope offline and is marked `unavailable_unverified` rather than
fabricated. See [`benchmark/deterministic_harness.mjs`](benchmark/deterministic_harness.mjs).

**Scope boundary.** This client governs `npm run dispatch` required actions; it cannot intercept a tool TrueForge core already allowed. The production design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) introduces a single `ToolExecutionCoordinator` for remote MCP, local/system tools, sandbox execution, client tools, and nested Code Mode calls. That is the mechanism that closes the chat/UI and direct-call boundary.

See [`src/runtime/gate.ts`](src/runtime/gate.ts), [`src/runtime/protocol.ts`](src/runtime/protocol.ts), [`src/runtime/evidence.ts`](src/runtime/evidence.ts), and their adversarial tests.

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

### Adaptive controls and current information

The portable TrueForge patch adds an accessible **/ Controls** palette to the composer for both draft and saved agents. Controls are sent through the ordinary turn input and enforced by the server—not simulated as client-only state:

```text
/model openai/gpt-5.2
/effort high
/goal Diagnose and repair the incident safely
/plan
/context add Production writes still require human approval
/task Reproduce the failure before editing
/request Investigate PROJECT-4A2
/completion A failing regression test passes and the full suite remains green
```

The server removes recognized leading control lines from model-visible request text, persists bounded state across turns/forks, validates models and advertised effort values, and projects the state as untrusted user metadata. None of these controls can bypass tool policy, approvals, authentication, sandbox limits, or the repository firewall.

For current information, configure Brave Search only in the patched TrueForge server environment:

```text
WEB_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=<host-only secret>
WEB_SEARCH_TIMEOUT_MS=15000
WEB_SEARCH_MAX_RESULTS=10
```

The UI shows whether executable `web_search` is available; credentials never enter AgentSpec or browser-visible capability responses. See [`patches/README.md`](patches/README.md) for patch identity and fail-closed application instructions.

Swap `LTP_MODEL` and the same agent runs on a different provider — TrueForge is vendor-neutral, and so is this.

## Quick start

**Requires Node 22.14+ and Corepack.** The patched TrueForge source is vendored in [`trueforge/`](trueforge); no sibling checkout or `npx @truefoundry/trueforge@latest` is used.

```powershell
# 1. Install the pinned pnpm 11.16.0 workspace dependencies.
npm run trueforge:install

# 2. Optional: edit trueforge\packages\trueforge\.env to enable host-only search.
# WEB_SEARCH_PROVIDER=brave
# BRAVE_SEARCH_API_KEY=<host-only secret>
# WEB_SEARCH_TIMEOUT_MS=15000
# WEB_SEARCH_MAX_RESULTS=10

# 3. Start the vendored standalone server and UI.
npm run trueforge:dev
```

Development URLs:

- UI: `http://localhost:3000`
- API and health endpoint: `http://localhost:8790` and `http://localhost:8790/healthz`

The install command creates `trueforge\packages\trueforge\.env` from `.env.example` only when it is missing; that local file is ignored and never overwritten. `trueforge:dev` uses SQLite, binds locally, and stops both child processes on exit. Run the focused vendored typechecks/build/tests with `npm run trueforge:check`.

Then configure and run Licence to Patch:

```powershell
# 4. In the TrueForge UI:
#      Settings → Models      → add a provider + API key
#      Settings → Connectors  → add "sentry" and "github"
#      Settings → Sandbox     → configure a sandbox provider

# 5. Configure and provision the saved agent.
Copy-Item .env.example .env   # fill in model, target repo, connector names
npm install
npm run doctor               # pre-flight: node version, server, agent
npm run provision            # creates the agent from src/agent/spec.ts

# 6. Dispatch an incident.
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
