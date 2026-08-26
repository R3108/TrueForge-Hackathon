# Three-minute demo script

Submission requires a 3:00 video. Presentation is one of six equally-weighted judging criteria, so this is worth rehearsing — not improvising.

## Before you record

- [ ] `npm run doctor` passes
- [ ] TrueForge chat UI open at `http://localhost:8790`, browser zoom ~125%
- [ ] A real, seeded bug in the target repo with a matching Sentry issue
- [ ] Terminal font large enough to read at 720p
- [ ] Qodo installed on the repo, so its review lands on camera
- [ ] Do one full dry run — the first run always finds something

## The cut

**0:00–0:20 — The problem, stated once**

> "It's 3am. Sentry fires. The stack trace is right there, the fix is four lines — and someone still has to wake up and do it. The tools that automate this either just suggest a patch, or they push to your repo while you're asleep."

Show the Sentry issue on screen. Real error, real stack trace.

**0:20–0:35 — The claim**

> "Licence to Patch does the whole job autonomously — and physically cannot touch your repository without you. Built on TrueForge."

Show `src/agent/spec.ts`, scrolled to `require_approval_for_tools`. Ten tool names. Don't read them out; let them sit on screen while you talk.

**0:35–1:45 — The run**

Run `npm run dispatch -- <issue-id>`. Narrate what's happening as it streams — don't narrate what you're typing.

Land these four beats:

1. *"It's reading the actual source at the culprit frame — not guessing from the stack trace."*
2. **The reproduction.** Slow down here. *"This is the part that matters. Before it writes any fix, it writes a failing test — and runs it in a sandbox that has never seen a GitHub token."* Show the test going red.
3. *"Now the fix. Same test, green. Full suite, green."*
4. Cut to the TrueForge UI mid-run for two seconds — subagents fanned out, the incident card rendered. Shows the harness working.

**1:45–2:20 — The gate**

The terminal stops. `CLEARANCE REQUIRED`. Let the pause breathe for a full second before you speak.

> "Here's the whole point. It wants to create a pull request. It stops. And it's not showing me a summary it wrote about what it's going to do — that's the literal argument to `create_pull_request`. What I approve is exactly what runs."

**Deny it first.** Type `n`, give a reason.

> "If I say no, it takes the no."

Show the agent accepting the denial and explaining what it would need. This is the strongest fifteen seconds in the video — nobody else's demo will do it, and it proves the gate is real rather than decorative.

Then re-run and approve.

**2:20–2:50 — The result**

The PR on GitHub. Scroll the body: Sentry link, root cause, the diff, test evidence, blast radius, how-to-verify.

Then Qodo's review appears on it.

> "Agent opens the PR. Qodo reviews it. A human approved the one step that touches the repo."

**2:50–3:00 — Close**

> "Full autonomy up to the repository boundary. A hard stop at it. That's the licence."

## Notes

- **Record the denial.** It is the single most differentiating moment available to you.
- **Don't narrate your typing.** Narrate what the agent is doing.
- **Don't explain TrueForge's architecture on camera.** Show it working; the README explains it.
- **Cut dead air ruthlessly.** Sandbox provisioning and test runs are slow — speed-ramp them, but never speed-ramp the approval pause.
- If a stage fails on camera, keep it and say so. Judges score honesty higher than a suspiciously perfect run, and a fake demo is easy to spot.
