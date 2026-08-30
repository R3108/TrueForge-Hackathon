# Roadmap to submission

**Deadline: Sunday 30 August, 20:00 London (00:30 IST Monday).**

Team: `R3108` · `skdas20` · `Lawliet2004` · `deba2k5`

---

## Status

| | |
| --- | --- |
| Hackathon submission | **Not submitted.** Nothing has been entered yet. |
| Repo | Scaffold + tests on `main`, 3 commits, PR #1 merged |
| Qodo | **Not installed** — PR #1 merged with zero reviews |
| TrueForge server | Not yet run |
| Demo video | Not started |

---

## Blockers — do these first

### B1. Install Qodo · **owner: R3108 only**

Nobody else can do this. `skdas20` has `admin: false`; installing a GitHub App requires admin.

1. Go to https://github.com/apps/qodo-merge-pro
2. **Configure** → select `R3108/TrueForge-Hackathon`
3. Comment `/review` on the next PR to confirm it responds

**Why it's urgent:** submission requires Qodo "from day one" with at least one *representative merged PR* linked in the README. PR #1 is merged but was never reviewed, so it does **not** count yet. Until Qodo is on, every merge we do is a wasted merge.

**Rule from here on: no direct commits to `main`. Every change goes through a PR that Qodo has reviewed.**

### B2. Model provider API key · **owner: whoever has credit**

An OpenAI (or Anthropic/Gemini) key is required unless someone attends the SF in-person day. Without it the agent cannot run at all.

### B3. `workflow` token scope · **owner: skdas20** · *low priority*

CI is written and waiting. Run `gh auth refresh -h github.com -s workflow`, click Authorize in the browser, then push `.github/workflows/ci.yml`.

---

## Work streams

These four run in parallel. Pick one each.

### Stream A — Get TrueForge running · *needs B2*

1. `npm run trueforge:install` — install the vendored workspace with pinned pnpm 11.16.0
2. `npm run trueforge:dev` — UI at http://localhost:3000, API at http://localhost:8790
3. **Settings → Models** — add provider + API key
4. **Settings → Connectors** — add `sentry` and `github` (GitHub needs a PAT with `repo`)
5. **Settings → Sandbox** — configure a sandbox provider (Daytona)
6. `Copy-Item .env.example .env`, fill it in
7. `npm run doctor` → all green
8. `npm run provision`

**Done when:** `npm run doctor` passes all three checks.

### Stream B — Build something to actually fix

The agent needs a real bug in a real repo, or there is no demo.

1. Create a small public repo — a tiny Express or Fastify service with a working test suite
2. Plant one genuine bug reachable from an HTTP route (a null deref on a missing field is ideal — realistic, small fix, easy to reproduce)
3. Create a free Sentry project, wire its SDK in, trigger the error so a real issue with a real stack trace exists
4. Note the Sentry short-ID — that's what gets passed to `npm run dispatch`

**Done when:** a real Sentry issue exists, and its stack trace points at a real line in a public repo.

**This is the long pole.** It doesn't depend on any blocker — start it now.

### Stream C — Demo video · *needs A + B*

Script is written: [`docs/DEMO.md`](docs/DEMO.md). Read it before recording.

1. Full dry run first — the first run always finds something
2. Record. **Record the denial** — deny the agent on camera, show it accept the "no". Nobody else's demo will do this.
3. Cut to 3:00 hard. Speed-ramp sandbox waits, never the approval pause.
4. Upload unlisted, link in README

**Done when:** a 3:00 video exists showing red test → fix → green test → gate → PR.

### Stream D — Free prize tracks · *anyone, anytime*

Two open tracks almost nobody contests:

- **Field Report** (Keychron keyboard) — a blog post write-up. Write it as we build, not after.
- **Radio Traffic** (swag, 10 winners) — social posts during the event.

Low effort, real prizes. Someone should own this from today.

---

## Submission checklist

Everything below must be true by 30 Aug 20:00 London.

- [ ] Public GitHub repo with a README a stranger can follow
- [ ] TrueForge visibly running the agent — real tool connection, sandbox execution, human pause-gate
- [ ] Qodo set up, **at least one representative merged PR linked in the README**
- [ ] Three-minute demo video
- [ ] Brief written explanation of what the agent does
- [ ] No shared credentials or personal data in the repo or the video
- [ ] Submitted on the hackathon site

## Judging criteria — six, equally weighted

| Criterion | Where we stand |
| --- | --- |
| Potential impact | Strong — on-call auto-repair is a real, expensive problem |
| Creativity & originality | Good — the gate-on-tool-call design is the differentiator |
| Technical excellence | Scaffold + tests done; needs a working end-to-end run |
| Use of sponsor tools | TrueForge is load-bearing; **Qodo is the gap** |
| Control & safety | Our strongest axis — gated writes, fails closed, tested |
| Presentation | Not started — video is everything here |

Only one prize track per team.
