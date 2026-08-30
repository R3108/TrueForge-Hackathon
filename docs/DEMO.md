# Three-minute demo script

**The submission requires 3:00. This script is timed to 2:55.**

Presentation is one of six equally-weighted criteria, and a judge is watching a lot of these. Every line here is written to be understood the first time, at speed, by someone who has not read the repo.

Setup lives in [RUNBOOK.md](RUNBOOK.md).

---

## Pick your track first

**Track A — live run + offline proof.** Record this if `npm run doctor` is green and a rehearsal worked. It has a human story and the strongest twenty seconds available to anyone in this hackathon: denying the agent on camera.

**Track B — offline only.** Record this if the live run won't cooperate. `npm run demo:firewall` needs no API key, no network, no Sentry, no GitHub, and proves the whole safety model deterministically in about two seconds.

**Track B is not a consolation prize.** A safety claim you can verify offline is stronger evidence than a safety claim someone watched work once. Do not burn hours fighting a connector to get Track A.

Both tracks are below. They share most of their material.

---

## Before you hit record

- [ ] `npm test` and `npm run typecheck` pass
- [ ] `npm run demo:firewall` passes
- [ ] Track A only: `npm run doctor` all green, and one `--rehearse` run completed
- [ ] Terminal font 18pt+. Judges watch at 720p.
- [ ] **Check your scrollback for tokens.** Clear it if unsure.
- [ ] Slack, Discord, mail closed
- [ ] Browser ~125% zoom, no personal bookmarks

---

# Track A — live run (2:55)

### 0:00–0:18 · The problem

**On screen:** the Sentry issue. Real error, real stack trace.

> "It's 3am. Sentry fires. The stack trace is right there, the fix is four lines — and someone still has to wake up and do it. The tools that automate this either just suggest a patch, or they push to your repo while you're asleep."

### 0:18–0:30 · The claim

**On screen:** `src/agent/spec.ts`, scrolled to `requireApprovalForTools`.

> "Licence to Patch does the whole job on its own — and cannot touch your repository without me. Built on TrueForge."

Let the ten tool names sit there. Don't read them out.

### 0:30–1:30 · The run

```bash
npm run dispatch -- CART-SERVICE-2
```

Narrate what the **agent** is doing. Never narrate your typing.

1. *"It's reading the actual source at the culprit frame — not guessing from the stack trace."*
2. **Slow down here.** *"Before it writes any fix, it writes a failing test — and runs it in a sandbox that has never seen a GitHub token."* Show the test going **red**.
3. *"Now the fix. Same test, green. Full suite, green."*

### 1:30–2:05 · The gate — the most important 35 seconds

The terminal stops. **Let it sit in silence for a full second** before speaking.

> "Here's the whole point. It wants to open a pull request, and it stops. This isn't a summary it wrote about what it's going to do — that's the literal argument to `create_pull_request`, and the approval is bound to that call's fingerprint. Change one character and this approval is worthless."

Point at the **Observed evidence** block:

> "And it isn't taking the agent's word that the tests passed. That came from the sandbox, at the current workspace state. If it had edited a file afterwards, this would say the evidence was stale."

**Now deny it.** Type `n`, give a reason.

> "And if I say no, it takes the no."

Show the agent receiving the denial and explaining what it would need. Then re-run and approve.

### 2:05–2:30 · The proof

**On screen:** `npm run demo:firewall` — let it scroll.

> "None of that depends on you trusting a demo. The whole safety model runs offline and deterministically: parallel calls resolving to the right call, wrong-repository writes refused, a two-attempt repair budget, and a circuit breaker so a blocked agent stops instead of grinding. No network, no API key."

### 2:30–2:48 · The result

**On screen:** the merged PR on `cart-service`, then Qodo's review on it.

> "The agent opens the PR. Qodo reviews it. A human approved the one step that touched the repo. And Qodo found real bugs in *our* gate along the way — they're in the write-up."

### 2:48–2:55 · Close

> "Full autonomy up to the repository boundary. A hard stop at it. That's the licence."

---

# Track B — offline only (2:50)

### 0:00–0:20 · The problem

Same as Track A. **On screen:** the Sentry issue if you have one; the bug in `cart-service`'s `src/cart.js` if not.

### 0:20–0:35 · The claim

> "Licence to Patch reads a production error, reproduces it in a sandbox with a failing test, fixes it, and opens a pull request — and cannot write to your repository without a human approving the exact tool call. Built on TrueForge."

**On screen:** `src/agent/spec.ts` at `requireApprovalForTools`.

### 0:35–0:50 · Why offline

```bash
npm run demo:firewall
```

> "Rather than ask you to trust a live run, the whole safety model runs deterministically offline. No network, no API key, two seconds."

### 0:50–2:20 · The six properties

Let it scroll and narrate as each lands. One sentence each.

| On screen | Say |
|---|---|
| **1. Exact correlation** | *"One model message can ask for several writes. Our first version checked the first one and approved a different one. Now every pause resolves to its own call — and if it can't, it fails closed."* |
| **2. Repository policy** | *"A write to the wrong repository is refused before a human is ever asked. Not a warning — a refusal."* |
| **3. Bounded repair** | *"A malformed call gets structured feedback and can try again. Twice. Then it stops."* |
| **4. Epoch-bound evidence** | *"'The tests passed' is a claim. This only counts it as evidence if it came from the sandbox at the current workspace state — edit a file afterwards and the evidence goes stale, because it is."* |
| **5. Approval checkpoint** | *"And after all of that, it still stops for a person. The card shows what was observed and what wasn't."* |
| **6. Circuit breaker** | *"Same failure twice, the agent stops. A boundary you can retry forever is a rate limit, not a boundary."* |

### 2:20–2:40 · The result

**On screen:** the merged PRs, then Qodo's reviews.

> "Every change went through a pull request Qodo reviewed. It found real bugs in our own gate — including that first one — and they're written up honestly in the blog post."

### 2:40–2:50 · Close

> "Full autonomy up to the repository boundary. A hard stop at it. That's the licence."

---

## Recording notes

- **Cut dead air ruthlessly.** Speed-ramp sandbox provisioning and test runs. **Never speed-ramp the approval pause** — that silence is the point.
- **Don't defend the project before you've shown it.** Establish the problem first; a judge who doesn't care yet won't follow a caveat.
- **If something fails on camera, keep it and say so.** Judges score honesty above a suspiciously perfect run, and a faked demo is easy to spot.
- **One scope sentence is enough.** To state the boundary honestly on camera: *"This gate governs the dispatch client; driving the same agent from the chat UI needs the same policy upstream, and that's written up in the architecture doc."* Then move on — don't spend thirty seconds on what you didn't build.
- Record 1080p, check it reads at 720p, upload unlisted, link it in the README.

## Claims to keep truthful

- Tool responses from SDK 0.1.3 are opaque strings and never receive a verified badge, even when they contain JSON-looking text. The offline fixture uses the trusted-host envelope; production core supplies typed outcomes.
- The dispatch gate covers required actions emitted to this client. The TrueForge chat UI and ungated local/Code Mode paths need the upstream coordinator — see [ARCHITECTURE.md](ARCHITECTURE.md).
- A failed or cancelled turn is a failed dispatch. The CLI prints `Incident closed` only after an explicit terminal `done`.
- If evidence is missing or stale, show that state rather than claiming green.
