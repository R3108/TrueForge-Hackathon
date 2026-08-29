# Runbook — setup, demo, submit

**For whoever is recording the video and submitting.** Follow this top to bottom. Nothing here assumes you built the project.

**Deadline: Sunday 30 August, 20:00 London.**

There are three repositories/services in play. Knowing which is which will save you an hour:

| | What it is |
| --- | --- |
| [`R3108/TrueForge-Hackathon`](https://github.com/R3108/TrueForge-Hackathon) | **The harness.** The agent, the approval gate, the CLIs. You run commands from here. |
| [`R3108/cart-service`](https://github.com/R3108/cart-service) | **The patient.** A small checkout service with a real bug. The agent opens its PR *here*. |
| TrueForge | The agent runtime. Runs locally on your machine at `localhost:8790`. |

The agent can write to `cart-service` and **cannot** write to the harness — different repository, and the harness refuses to target itself. That separation is a thing to say out loud in the video.

---

## Part 1 — Setup (about 30 minutes, once)

### 1.1 What you need before you start

- **Node 22.14 or newer.** Check with `node -v`. If it's older, install from [nodejs.org](https://nodejs.org).
- **An OpenAI API key** (or Anthropic/Gemini). This is the one thing that costs money. A full demo run is cents, not dollars.
- **A fine-grained GitHub personal access token, restricted to `R3108/cart-service` only** → [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new). Under "Repository access" choose *Only select repositories* → `R3108/cart-service`; grant *Contents: Read and write* and *Pull requests: Read and write*. Do **not** use a classic PAT with `repo` scope: it can reach every repository you can, including this harness, and the whole safety claim — "the agent cannot reach the gate that governs it" — rests on the token not containing this repository.
- **A free Sentry account** → [sentry.io](https://sentry.io).

### 1.2 Start TrueForge

In its own terminal, leave this running for the whole session:

```bash
npx @truefoundry/trueforge@latest
```

Open **http://localhost:8790**. First run takes a minute to download.

### 1.3 Configure TrueForge in the browser

Three things, all in the TrueForge UI:

**Settings → Models.** Find your provider, click Configure, paste the API key, Create.

Then find the exact model name — the config needs the fully-qualified name and the dots become dashes:

```bash
curl http://localhost:8790/api/v1/models
```

Copy the exact string (e.g. `openai/gpt-5-6-terra`, not `gpt-5.6`). You'll need it in 1.5.

**Settings → Connectors.** Add two, and the **names must match exactly** — the agent looks them up by name:

| Name | URL | Auth |
| --- | --- | --- |
| `github` | `https://api.githubcopilot.com/mcp/` | Header: `Authorization: Bearer <your fine-grained PAT, scoped to R3108/cart-service only>` |
| `sentry` | `https://mcp.sentry.dev/mcp` | Click Connect, authorize in the popup |

**Settings → Sandbox.** Configure a sandbox provider (Daytona). The agent needs this to reproduce the bug — without it, stage 3 cannot run and there is no demo.

### 1.4 Wire Sentry to the cart service

This is what produces the real error the agent reads.

```bash
git clone https://github.com/R3108/cart-service
cd cart-service
npm install
```

In Sentry: create a project (platform: **Node.js**), copy the **DSN**.

```bash
cp .env.example .env
```

Put the DSN in `.env`, then start the service:

```bash
npm start
```

In a second terminal, trigger the bug:

```bash
curl -X POST http://localhost:3000/cart/quote \
  -H 'Content-Type: application/json' \
  -d '{"currency":"GBP"}'
```

That request omits `items`, and `quote()` calls `.reduce` on it. You should get a 500, and **an issue should appear in Sentry within about 30 seconds**.

In Sentry, open the issue and copy its **short ID** — it looks like `CART-SERVICE-2`. Write it down; it's what you pass to the agent.

> If nothing arrives in Sentry, the DSN is wrong or `instrument.js` isn't loading. `npm start` must run through `--import ./instrument.js` (it does by default).

### 1.5 Configure the harness

```bash
git clone https://github.com/R3108/TrueForge-Hackathon
cd TrueForge-Hackathon
npm install
cp .env.example .env
```

Edit `.env` — only two lines usually need changing:

```
LTP_MODEL=openai/gpt-5-6-terra        # the exact string from step 1.3
LTP_TARGET_REPO=R3108/cart-service    # already correct
```

### 1.6 Provision and check

```bash
npm run provision   # creates the agent on the server from src/agent/spec.ts
npm run doctor      # pre-flight
```

**Do not proceed until `doctor` is all green.** It checks the Node version, that the server is up, that the agent exists, that the connectors are authorized, that Sentry is read-only, and that the live agent's gate still matches the repo. Every red line here becomes a problem on camera.

### 1.7 Rehearse

```bash
npm run dispatch -- --rehearse CART-SERVICE-2
```

`--rehearse` runs the whole thing for real — reads Sentry, reads the code, reproduces the bug in the sandbox, writes the fix — and then **refuses every write**. Nothing reaches GitHub. It costs you one model run and tells you whether the demo will work.

Watch for: does it find the issue, does the test go red, does it go green, does the clearance prompt appear? If yes, you're ready to record.

---

## Part 2 — The video (3:00 hard limit)

Read [DEMO.md](DEMO.md) too — this is the operational version of it.

### Before you hit record

- [ ] `npm run doctor` green
- [ ] One rehearsal completed successfully
- [ ] Terminal font large — 18pt+. Judges watch at 720p on a laptop.
- [ ] Browser at ~125% zoom, tabs closed, no personal bookmarks visible
- [ ] Nothing on screen with a real token in it. Check your terminal scrollback.
- [ ] `cart-service` open in a browser tab, and the Sentry issue in another
- [ ] Close Slack/Discord/mail. A notification toast in the video looks careless.

### The cut

**0:00–0:20 · The problem**

> "It's 3am. Sentry fires. The stack trace is right there, the fix is four lines — and someone still has to wake up and do it. The tools that automate this either just suggest a patch, or they push to your repo while you're asleep."

On screen: the Sentry issue. Real error, real stack trace.

**0:20–0:35 · The claim**

> "Licence to Patch does the whole job autonomously — and physically cannot touch your repository without you. Built on TrueForge."

On screen: `src/agent/spec.ts`, scrolled to `requireApprovalForTools`. Let the ten tool names sit there while you talk. Don't read them out.

**0:35–1:45 · The run**

Run it. Narrate what the *agent* is doing, not what you're typing.

```bash
npm run dispatch -- CART-SERVICE-2
```

Four beats:

1. *"It's reading the actual source at the culprit frame — not guessing from the stack trace."*
2. **The reproduction — slow down here.** *"Before it writes any fix, it writes a failing test, and runs it in a sandbox that has never seen a GitHub token."* Show the test going **red**.
3. *"Now the fix. Same test, green. Full suite, green."*
4. Cut to the TrueForge UI for two seconds — subagents, the incident card. Shows the harness working.

**1:45–2:20 · The gate — the most important 35 seconds**

The terminal stops. `CLEARANCE REQUIRED`. **Let it sit in silence for a full second** before you speak.

> "Here's the whole point. It wants to open a pull request. It stops. And that's not a summary it wrote about what it's going to do — that's the literal argument to `create_pull_request`. What I approve is exactly what runs."

**Now deny it.** Type `n`, give a reason.

> "And if I say no, it takes the no."

Show the agent accepting the denial and explaining what it would need.

**This is the single most differentiating moment in the video. Nobody else will do it.** Then re-run and approve.

**2:20–2:50 · The result**

The PR on `cart-service`. Scroll the body: Sentry link, root cause, the diff, test evidence, blast radius, how-to-verify. Then Qodo's review lands on it.

> "The agent opens the PR. Qodo reviews it. A human approved the one step that touched the repo."

If three seconds remain, cut back to the terminal: the decision table and the audit digest. *"And there's a record — the denial, the approval, and a digest that changes if anyone edits the file."* Only if it fits. The denial is worth more.

**2:50–3:00 · Close**

> "Full autonomy up to the repository boundary. A hard stop at it. That's the licence."

### Recording notes

- **Cut dead air ruthlessly.** Sandbox provisioning and test runs are slow — speed-ramp them. **Never speed-ramp the approval pause.**
- **If something fails on camera, keep it and say so.** Judges score honesty above a suspiciously perfect run, and a faked demo is easy to spot.
- Record 1080p if you can, but check it's readable when scaled to 720p.
- Upload unlisted to YouTube. Put the link in the README.

---

## Part 3 — Submit

Before the form:

- [ ] Demo video uploaded, link added to the README
- [ ] README links **one merged PR that Qodo reviewed** — this is a hard requirement
- [ ] Both repos public
- [ ] No credentials anywhere in either repo, or visible in the video
- [ ] CI green on `main`

Then submit at **https://www.wemakedevs.org/hackathons/trueforge** with:

- The repo link: `https://github.com/R3108/TrueForge-Hackathon`
- The video link
- A short description — this works:

> Licence to Patch is an on-call agent that takes a production error from Sentry, reproduces it in a sandbox with a failing test, writes the fix, and opens a pull request — and cannot write to a repository without a human approving the literal tool call. Reads run autonomously; every repository write stops at a gate, is checked against a path perimeter and a credential tripwire first, and is recorded in a hash-chained decision journal. The agent repairs a service in a separate repository, so it has no access to the gate that governs it.

**One track only.** Double-O (best use of TrueForge) is the strongest fit.

Don't forget the free tracks — **Field Report** (blog post) and **Radio Traffic** (social posts) are barely contested.

---

## If something breaks

| Symptom | Fix |
| --- | --- |
| `doctor` says agent not provisioned | `npm run provision` |
| `doctor` says connector unauthorized | TrueForge UI → Settings → Connectors → Connect |
| `doctor` says the gate has drifted | Someone edited the agent in the UI. `npm run provision` restores it from the repo. |
| `LTP_TARGET_REPO is ... the agent's own harness` | `.env` points at the harness. It must be `R3108/cart-service`. |
| Model not found | Wrong FQN. Re-run `curl http://localhost:8790/api/v1/models` — dots become dashes. |
| No Sentry issue appears | DSN wrong, or the service didn't start via `instrument.js`. |
| Agent can't reproduce the bug | Expected behaviour when it genuinely can't — it's instructed to say so and stop. Check the sandbox provider is configured. |
| Every write is denied without asking | You're in `--rehearse`, or there's no TTY. Drop the flag; run in a real terminal. |
| Blocked by write perimeter | The agent tried to write outside `src/**`. Check with `npm run perimeter -- <path>`. |
| Run hangs after the answer | Fixed in #5. Make sure you're on latest `main`. |

---

## Known follow-up

`fixture/` still exists in this repository as a leftover copy of the service. The live target is [`R3108/cart-service`](https://github.com/R3108/cart-service) — that is what the agent reads and patches, and what you clone in step 1.4. Deleting the stale copy needs a token with the `workflow` scope because it also updates CI; it changes nothing about how the demo runs.
