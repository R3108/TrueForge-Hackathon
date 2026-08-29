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
- **It fails closed.** No TTY — CI, a piped stdin, an unattended run — and every pending write is denied automatically. Ctrl-C at a prompt is an answer, not an absence of one: the write in front of you and every write behind it are denied. The unsafe direction is never the default.

## Verified self-healing firewall

The repository perimeter is now one rule in a typed gate, not the whole control. At the SDK required-action boundary the runtime:

- resolves every `toolCalls[]` reference by source event and exact call ID (including parallel call B);
- keeps approval actions and client-response actions as different protocol types;
- binds GitHub policy to the configured MCP server name and stable server ID, then checks exact repository, repository-relative paths, allowlisted paths, secret paths, protected branches, destructive tools, and known required fields;
- returns bounded structured repair feedback without mutating or replaying the original call;
- binds one-shot approval to session, turn, thread, call ID, HMAC argument fingerprint, and policy version;
- invalidates test evidence whenever the observed workspace/repository epoch advances; and
- closes only on explicit terminal `done`, never on failed or cancelled turns.

And the boundary starts one layer earlier than the gate itself. `LTP_TARGET_REPO` is **repo-granular**: once the agent may write to a repository, the harness will let it write anywhere in that repository. So the service it repairs — [**R3108/cart-service**](https://github.com/R3108/cart-service) — is a *different repository from this one*. The agent's GitHub scope simply does not contain its own approval gate, which makes "it cannot disarm itself" a fact about credentials rather than a promise about glob matching. Pointing `LTP_TARGET_REPO` at this harness is refused at startup, and CI asserts that the refusal still works. Inside the target, the perimeter is the second layer: the agent owns the service's source, but not the CI that verifies its patch.

The configured boundary remains:

```text
LTP_TARGET_REPO=R3108/cart-service
LTP_BASE_BRANCH=main
LTP_WRITE_PATHS=src/**,!.github/**,!package.json,!package-lock.json
LTP_EXECUTION_TOOL_ID=<stable host tool-set id>
LTP_EXECUTION_TOOL_NAME=<stable host tool-set name>
```

A wrong repository, traversal, absolute path, secret path, protected-base write, destructive operation, or unknown approval-gated tool is denied before a human is asked. A deterministic missing-field failure receives JSON feedback and must return as a new call ID. A repeated invalid fingerprint or exhausted two-attempt budget opens the circuit.

The final checkpoint shows policy, repository/branch/path, call fingerprint, repair budget, historical regression evidence, current-epoch targeted/full-suite evidence, and whether success text lacked structured execution facts. The evidence informs approval; it never replaces TrueForge's required human decision.

The agent receives the denial and the reason, and can explain what it would need — it simply cannot get there. Path traversal is resolved before matching, so `src/../.github/workflows/ci.yml` is outside the perimeter too; a boundary you can walk out of with `../` is not a boundary. A multi-file push is rejected whole if any single file escapes. A `!` pattern carves an exception out of a grant, and exceptions win — nothing inside `src/**` lets the agent rewrite the CI workflow that *checks* its patch.

**You can ask the boundary what it would do, without running the agent:**

```bash
npm run perimeter -- src/cart.js .github/workflows/ci.yml package.json

ALLOW  src/cart.js                       matches src/**
BLOCK  .github/workflows/ci.yml          excluded by !.github/**
```

And because the perimeter is the one control that protects all the others, CI asserts it on every pull request. A pull request that widens the perimeter far enough to reach the approval gate fails CI before a human reads the diff — which matters, because the change that quietly removes a boundary is exactly the change nobody reads carefully. `npm run doctor` makes the same check against your live `.env`.

**Run the complete proof without external services:**

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

## The credential tripwire

The perimeter decides *where* the agent may write. This decides *what*.

Stage 3 runs real code in a sandbox. An agent debugging an auth failure legitimately ends up holding a token in its context, and the most natural thing in the world is to paste the value that finally made the test pass straight into the patch. Nothing about the approval prompt catches that: the diff looks fine, because a leaked secret looks exactly like a working config.

So every payload bound for the repository — each file in a multi-file push, the commit message, the PR body — is scanned before it is offered for approval, and a hit is refused the same way a perimeter breach is:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  BLOCKED BY CREDENTIAL TRIPWIRE
  Denied automatically. No approval was offered.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  create_or_update_file
        found      GitHub personal access token in src/client.js:14 — ghp_****** (44 chars)
```

The rules are narrow on purpose — issuer prefixes, private key blocks, JWTs, and hardcoded assignments whose value doesn't look like a placeholder. A scanner that fires on every long string is a scanner people turn off. `LTP_SECRET_POLICY=warn` downgrades it to a red line on the approval prompt; `off` disables it. The default is to refuse, because a credential is not something a tired operator should have the option to wave through, and the cost of a false positive is one word in a config file.

Note what the denial does *not* contain: the secret. A leak report that quotes the leak has moved it somewhere new.

## The decision journal

An approval gate is only as good as what it can prove afterwards. "The agent asked, someone said yes" is the single most important fact about an incident — and until it is written down, it lives in terminal scrollback that scrolls away.

Every decision is appended to `runs/<session>.jsonl` as it happens, and each record carries the hash of the record before it:

```bash
npm run journal -- runs/sess_01J8Z.jsonl

#  WHEN     TOOL                   PATHS                OUTCOME            OPERATOR
1  4m ago   create_branch          —                    approved           ada@oncall-1
2  4m ago   create_or_update_file  src/cart.js          approved           ada@oncall-1
3  3m ago   create_or_update_file  src/agent/spec.ts    blocked-perimeter  ada@oncall-1

  CHAIN VERIFIED 3 record(s)
  digest  sha256:f0e3b789…
```

Edit a line and the chain stops verifying; delete one and the record after it no longer points at anything. The run prints the same digest when it finishes, so a dropped tail is detectable too — paste it into the incident ticket and the file can be checked against it later by anyone.

It also records the outcomes a transcript flattens together. `denied` (a human said no), `denied-no-tty` (nobody was there), `blocked-perimeter` and `blocked-secret` (nobody was asked) are four different facts about a run, and only the first one means a person reviewed it.

This is a local audit trail, not a signed one: it proves the file has not been quietly edited, not who ran it. Journals are git-ignored — an audit trail belongs to the machine that made the decisions.

## Rehearsal

```bash
npm run dispatch -- --rehearse PROJECT-4A2
```

The whole run, with every repository write refused by policy. The agent is told it is a rehearsal, works the incident to the end anyway, and reports exactly what it would have pushed; the perimeter and the tripwire still report what *they* would have caught. It is how you point this at an unfamiliar repository for the first time, and how CI can exercise the full path without a standing offer to write to anything.

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

> **Recording the demo or submitting?** Follow [docs/RUNBOOK.md](docs/RUNBOOK.md) instead — it is the same setup written end to end, with the video script and the submission checklist.

**Requires Node 22.14+ and Corepack.** The patched TrueForge source is vendored in [`trueforge/`](trueforge); no sibling checkout or `npx @truefoundry/trueforge@latest` is required.

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
npm run dispatch -- --rehearse PROJECT-4A2   # first time: refuse every write
npm run dispatch -- PROJECT-4A2
```

`npm run doctor` exists because the worst time to discover an unauthorized connector is halfway through a demo. It also compares the agent *on the server* against the spec in this repository, and refuses to call the run green if the two have drifted — someone editing the agent in the TrueForge UI to unstick a demo should not be able to remove the approval gate while the repo still claims it is there.

| Command | |
| --- | --- |
| `npm run doctor` | pre-flight: node, server, agent, gate drift, perimeter |
| `npm run provision` | make the server match `src/agent/spec.ts` |
| `npm run dispatch -- <id>` | run one incident, `--rehearse` to refuse all writes |
| `npm run perimeter -- <paths…>` | ask the boundary what it would do |
| `npm run journal -- <file>` | verify and print a run's decision record |

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
  runtime/secrets.ts   the credential tripwire; what may be written, not where
  runtime/journal.ts   the tamper-evident record of what was decided
  runtime/render.ts    terminal rendering, and what a write actually touches
  cli/provision.ts     create/update the saved agent from the spec
  cli/dispatch.ts      run one incident end to end
  cli/doctor.ts        pre-flight checks, including gate drift and perimeter sanity
  cli/perimeter.ts     judge paths against the perimeter; assertable in CI
  cli/journal.ts       verify a decision journal's hash chain
docs/RUNBOOK.md        end-to-end setup, and the demo hand-off
runs/                  decision journals (git-ignored)
docs/
  ARCHITECTURE.md      how the pieces fit, and why the gate sits where it does
  DEMO.md              the three-minute demo script
SECURITY.md            threat model: what these controls do and do not cover
CONTRIBUTING.md        how to work on this, and the rule about the control plane
```

The agent lives in **one reviewable file**. `src/agent/spec.ts` is the entire definition — instructions, tool filters, approval policy, sandbox, context management. Nothing is hand-clicked in a UI and lost; `npm run provision` makes the server match the repo.

## Code review

Every substantive change lands through a pull request reviewed by **[Qodo](https://www.qodo.ai/)**. No direct commits to `main`.

<!-- TODO(before submission): link the representative merged PR here. -->

## Safety and scope

- The agent only ever writes to the single repository named in `LTP_TARGET_REPO`, and only to paths inside `LTP_WRITE_PATHS`.
- Sentry is attached read-only (`enableTools: ['@read-only']`) — incidents are read, never mutated.
- Credentials live in TrueForge connectors. This repository contains no tokens, and `.env` is git-ignored.
- Payloads are scanned for credentials before they are offered for approval, and refused by default.
- Every decision is journalled, and the journal is tamper-evident.
- One PR per incident, always branched off the base branch, never pushed to it.

The threat model — including what these controls deliberately do *not* cover — is written out in [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
