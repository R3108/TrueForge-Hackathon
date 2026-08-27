# Security

This project's whole claim is a safety claim, so it owes you a precise statement of what it does and does not defend against. Marketing a control as stronger than it is does more damage than not having it.

## What this is

An agent with full autonomy up to the repository boundary and a hard stop at it. It reads production errors, reasons, runs code in a sandbox, and then has to ask.

## Controls, and what each one actually covers

| Control | Covers | Does not cover |
| --- | --- | --- |
| **Harness approval gate** (`requireApprovalForTools` in `src/agent/spec.ts`) | Every repository-mutating GitHub tool pauses the turn until a decision is sent back. Enforced by TrueForge, not by the model. | Tools not named in the list. Adding a connector without updating the gate silently widens it — `npm run doctor` checks the server against the repo for exactly this. |
| **Write perimeter** (`src/runtime/perimeter.ts`) | Path-level allow/exclude for `npm run dispatch`. Traversal is resolved before matching; a multi-file push is refused whole if any file escapes. | Anything driving the same agent by another route — the TrueForge chat UI, a direct SDK call — where only the harness's repo-level gate applies. |
| **Credential tripwire** (`src/runtime/secrets.ts`) | Known credential shapes and hardcoded assignments in any payload bound for the repository. | Novel or encoded secrets, and anything the agent leaks somewhere other than a repository write. It is a tripwire, not a DLP system. |
| **Fail-closed prompt** (`src/runtime/approvals.ts`) | No TTY, or Ctrl-C, denies every pending write. | Nothing here defends against an operator who approves without reading. The prompt is built to make reading cheap; it cannot make it mandatory. |
| **Decision journal** (`src/runtime/journal.ts`) | A tamper-evident local record of every decision, chained by hash. | Attribution. It proves the file was not edited after the fact; it does not prove who ran it. Not signed, not remote, not append-only at the filesystem level. |

## Assumptions

- **The TrueForge server is trusted.** It holds the credentials and enforces the gate. If it is compromised, none of the above helps.
- **The sandbox is untrusted, and holds nothing.** Code the agent writes runs there; the GitHub and Sentry credentials never do. That separation is structural — the agent loop stays on the server — not a matter of discipline.
- **The model is untrusted.** Instructions in `src/agent/spec.ts` shape behaviour but enforce nothing. Every claim in this repository about what the agent *cannot* do refers to a control outside the model.
- **The operator is trusted but tired.** This is the design's central assumption. It is why the perimeter and the tripwire refuse rather than warn: at 3am the difference between a red prompt and no prompt is the whole control.

## Known gaps

These are real, and listed rather than hidden.

1. **The perimeter is client-side.** It governs `npm run dispatch`, which is the operating path, but it is not a property of the agent itself. Moving it into the harness would close this.
2. **`LTP_TARGET_REPO` is repo-granular.** The perimeter narrows it to paths, but the underlying connector grant is still the whole repository.
3. **Approval is per-call, and a large fix is several prompts.** Fatigue is a real attack surface. Batching them would be worse, but the trade-off is not free.
4. **The journal is local.** A compromised host can delete it. It detects edits, not deletion of the whole file.

## Reporting a vulnerability

Open a GitHub issue for anything that is already public (a wrong claim in this file, a hole in the perimeter's matching logic, a tripwire bypass with a public credential format).

For anything that would be harmful to publish before it is fixed, use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability) rather than an issue or a pull request.

Please include what you did, what you expected the boundary to do, and what it did instead. A failing test against `src/runtime/perimeter.ts` or `src/runtime/secrets.ts` is the most useful possible report.
