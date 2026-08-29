# Four-minute verified-firewall demo

The primary demo is deterministic and independent of TrueForge, GitHub, Sentry, and Daytona availability:

```powershell
npm install
npm run demo:firewall
```

A live `npm run dispatch -- <incident>` run is optional. Do not substitute live luck for the deterministic safety proof.

## Before recording

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run demo:firewall` passes
- [ ] Terminal font is readable at 720p
- [ ] `docs/ARCHITECTURE.md` is open at the production coordinator diagram
- [ ] If showing a live run, `npm run doctor` also passes

## The cut

**0:00–0:25 — Make the claim precise**

> "Retries, hooks, and JSON schema validation are not individually new. The claim is that TrueForge can turn a malformed or policy-invalid tool call into a corrected, independently approved action—while proving stale approvals, unsafe retries, and repeated loops cannot bypass policy."

Run `npm run demo:firewall`.

**0:25–0:55 — Exact parallel-call correlation**

Show calls A and B and the required action naming B.

> "The old client selected the first call in a model message. A pause for B could display A while routing the decision under B's ID. The resolver now follows every source-event reference and exact call ID. Missing or ambiguous references fail closed."

Pause on the green line confirming B resolved to B.

**0:55–1:20 — Enforced policy, not prompt advice**

Show the wrong-repository fixture being denied.

> "The target repository, repository-relative path, write perimeter, secret paths, protected branch, and destructive-operation rules are checked against actual arguments. A plausible prompt cannot authorize a different repository."

**1:20–2:00 — Bounded structured repair**

Show the malformed file call with no path and its JSON feedback. Point out the original and corrected IDs.

> "The gate does not silently fix or replay the call. It emits bounded, field-specific feedback. The model must issue a new call. New semantics mean a new fingerprint and fresh human approval. An identical invalid fingerprint stops on its second occurrence."

**2:00–2:45 — Verified evidence and approval identity**

Show the regression, workspace mutation, targeted pass, and full-suite pass. Then pause on the rendered approval card.

> "A green badge requires a recognized test command, exact response correlation, completion without timeout, and a structured zero exit code. The workspace mutation advances the epoch, invalidating older current-state evidence. The historical red baseline remains labeled historical; current targeted and full-suite passes are bound to epoch one."

Point to call ID, fingerprint, repair budget, repository, branch, and evidence rows.

> "This card informs the decision; it never replaces TrueForge's required human approval. Approval is one-shot and bound to session, turn, thread, call ID, fingerprint, and policy version."

**2:45–3:15 — Replay and loop stopping**

Show the circuit-breaker and offline metric lines.

> "Duplicate required-action events replay the recorded decision without another prompt. Human denial terminates the repair chain. Repeated fingerprints and the two-attempt repair budget stop model loops; the whole continuation is also capped at twelve turns."

**3:15–3:50 — Production boundary**

Show the `ToolExecutionCoordinator` diagram in `docs/ARCHITECTURE.md`.

> "This hackathon client controls Licence to Patch's required-action boundary. It does not pretend to intercept a call TrueForge core already allowed. Production closes that boundary by making one coordinator the only path to remote MCP, local and system tools, sandbox execution, client tools, deferred tools, and nested Code Mode calls. Interceptors can tighten core policy, never weaken it."

Mention typed outcomes and reconciliation:

> "A timeout after a remote write is unknown, not failed. The coordinator reconciles idempotent or queryable writes and never blindly retries an ambiguous destructive write. Attempts and approvals use TrueForge's existing SQLite/Postgres session store."

**3:50–4:00 — Close**

> "Malformed call, precise repair, fresh human approval, current evidence, deterministic loop stopping—and a concrete path to comprehensive core interception."

## Optional live appendix

If services are available, run a real incident after the deterministic segment. Keep the language truthful:

- SDK tool responses in 0.1.3 are opaque content strings and never receive verified badges, even when they contain JSON-looking text. The offline fixture uses the fixed trusted-host envelope; production core supplies typed outcomes.
- The dispatch gate covers required actions emitted to this client. The TrueForge chat UI and ungated local/Code Mode paths require the upstream coordinator.
- A failed or cancelled turn is a failed dispatch. The CLI prints `Incident closed` only after explicit terminal `done`.
- If evidence is missing or stale, show that state rather than claiming green.
