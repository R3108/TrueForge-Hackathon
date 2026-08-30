# We built an agent that fixes production bugs. The hardest part was stopping it.

*Building Licence to Patch on TrueForge — and the bug a code reviewer found in our own safety code.*

---

It's 3am. Sentry fires. You open your laptop, read a stack trace, find the file, reproduce the failure, write a test, patch four lines, open a PR, and go back to bed.

Every part of that is mechanical except the judgement. So we built an on-call agent to do the mechanical parts: **Licence to Patch**, built on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source agent harness.

It reads the Sentry issue, reads the actual source at the culprit frame, reproduces the bug in a sandbox with a failing test, writes the smallest fix that turns it green, and opens a pull request.

Then it stops and asks you.

That last sentence is the whole project. This post is about the four decisions behind it — and about the moment a code reviewer found a hole in the safety mechanism we were most confident about.

---

## The two ways this usually goes wrong

Tools in this space fail in one of two directions.

Some are a chat window. They suggest a patch and leave you to do the work. Safe, and barely worth the tab.

Others are autonomous bots that push to your repository while you sleep. You find out what they decided in the morning. Fast, and nobody senior will turn it on.

We wanted the third thing: **full autonomy right up to the repository boundary, and a hard stop at it.** The agent reads, reasons, reproduces and tests entirely on its own. The instant it wants to write to your repo, it stops.

Getting that right turned out to be four decisions.

---

## Decision 1: Gate the tool call, not the final answer

The obvious design is to let the agent finish, then show a human the diff: *"here's the patch, ship it?"*

It sounds equivalent. It isn't.

By the time you see that summary, the agent has already decided everything, and you are reading a description of the work written by the same thing that did the work. If the description and the action disagree, you have no way to know.

So the gate sits on the **individual tool call**. When the agent calls `create_pull_request`, TrueForge pauses the turn and hands us the literal arguments — the real branch, the real file contents, the real body. That's what the operator sees. There is no gap between what is approved and what executes, because they are the same object.

In the agent spec, that's just a list:

```ts
{
  name: 'github',
  enableTools: ['@all'],
  requireApprovalForTools: [
    'create_branch',      'create_or_update_file', 'push_files',
    'delete_file',        'create_pull_request',   'update_pull_request',
    'merge_pull_request', 'create_issue',          'update_issue',
    'add_issue_comment',
  ],
}
```

Reads run free. Writes stop dead. And crucially, **the harness enforces this, not the model** — it cannot be talked out of it, because the thing doing the enforcing isn't listening to the conversation.

---

## Decision 2: No fix without a reproduction

An agent that skips reproduction produces *plausible* patches. It reads a stack trace, pattern-matches to something that looks like the cause, and writes a confident diff. Sometimes it's right.

So the agent is required to work six stages in order, and stage three is: **reproduce the failure in the sandbox with a test that fails.** It has to show red before it's allowed to write anything that might make it green.

TrueForge treats the sandbox as a *tool* rather than as the agent's home — the loop and its credentials stay on the server, and only code execution happens in the isolated environment. That matters more than it first appears: the untrusted code the agent writes in stage three runs somewhere that **has never seen the GitHub token**. Credential custody and code execution are in different places by construction, not by discipline.

The agent is also explicitly instructed that failing to reproduce is an acceptable outcome:

> If you cannot reproduce the failure, say so plainly, explain what you tried, and stop — do not proceed to a fix.

A truthful *"I couldn't reproduce this"* is worth more than a confident wrong patch. Most of the work in agent design is making the honest answer available.

---

## Decision 3: Fail closed

What happens when nobody's watching?

If the approval prompt runs without a terminal — in CI, with piped stdin, in an unattended run — every pending write is **denied automatically**. Not queued, not auto-approved. Denied, with a reason the agent receives and can explain.

Ctrl-C at the prompt is treated as a "no", not as an unanswered question. Walking away is an answer.

This is a small amount of code and the single most important property in the system, so it's the part with the most tests. If you can only test one thing in a safety mechanism, test the direction it fails in.

---

## Decision 4: A different repository — and how we learned it the hard way

Here's the part we got wrong first.

We used [Qodo](https://www.qodo.ai/) to review every pull request from day one. On the PR that introduced our write perimeter, it wrote something we didn't want to hear: the service the agent repairs was living *inside the agent's own repository*.

GitHub permissions are repo-granular. Once the agent can write to a repository, it can write anywhere in it. Our defence was a glob allowlist — `fixture/**` — that kept it away from `src/agent/spec.ts`, the file defining its own approval gate.

Which meant the entire safety argument rested on **one glob matcher being correct**.

Then Qodo found this, in the glob matcher:

> `globToRegExp` drops the slash after `**`, so a pattern such as `safe/**/config.json` compiles to a form that also matches `safe/evilconfig.json`. This silently broadens a configured security allowlist beyond normal glob semantics.

It was right. Our boundary had a hole in it, and the hole was in the code whose only job was to be the boundary.

The fix was two lines. The lesson was bigger: we moved the service under repair into [its own repository](https://github.com/R3108/cart-service). Now the agent's token doesn't include the harness at all. "The agent cannot disarm itself" stopped being a property of our pattern matching and became a property of the credential it holds. The perimeter is still there — but as the second layer, not the only one.

We also made the harness refuse to target its own repo at startup, with no override flag. A switch to turn that off would be the first thing anyone reached for at 3am.

---

## The one that actually scared us

Qodo found something worse on the next PR, and this one is worth describing precisely.

A single model message can contain **several tool calls**, and each one gets its own approval pause. Our code resolved each pause back to `calls[0]` — the first call in the message — every time.

Picture the agent asking for two writes in one message:

| | path | perimeter |
|---|---|---|
| `call_1` | `src/cart.js` | inside |
| `call_2` | `.github/workflows/ci.yml` | **outside** |

Both pauses resolved to `call_1`. So the perimeter checked `cart.js`. The credential scanner scanned `cart.js`. The operator was *shown* `cart.js` and typed `y`.

And the approval was routed to `call_2`.

Three independent safety mechanisms, all inspecting the wrong object, all agreeing, all wrong. The human saw a legitimate write and authorised a different one.

Nothing in our test suite caught it, because every test we'd written used one tool call per message. The bug lived exactly in the gap between "the case we imagined" and "the case that happens".

Calls are now matched by `tool_call_id`, and a pause that *can't* be matched is refused outright rather than guessed at — nothing downstream can vouch for arguments it doesn't have.

That finding is the strongest argument we can make for automated review on agent code. We wrote the safety model, we believed in it, we tested it, and it had a hole you could drive a pull request through.

---

## What it looks like when it runs

Three checks stand between a gated call and your repository, in this order:

```
tool.approval_required
        │
  1  write perimeter     where?  ── outside ──►  DENIED, no human asked
        │ inside
  2  credential tripwire what?   ── found ────►  DENIED, no human asked
        │ clean
  3  the human           should we?           ── no TTY / Ctrl-C ──► DENIED
        │
     approved  ──►  the call runs

  every outcome ──►  appended to a hash-chained decision journal
```

The first two **refuse** rather than warn, deliberately. The two questions they answer — *is this file mine to write?* and *is this payload a credential?* — are exactly the two a tired human is worst at. A boundary an operator can be walked through at 3am is a boundary that will be walked through at 3am.

The third question — *is this the right fix?* — is the one only a person can answer. It's the only one they're asked.

---

## What we'd do differently

**The perimeter and the tripwire live in our client, not in the harness.** They govern the operating path, but they aren't properties of the agent itself — someone driving the same agent from the chat UI doesn't get them. Server-side path policy is the right home for this, and it's the first thing we'd contribute upstream.

**We'd want ingress redaction, not just egress.** We scan everything going *to* the repository. Nothing scans what comes *back* from a tool into the transcript, the logs, and the recorded demo. A credential in your terminal scrollback is a real leak.

**The journal proves integrity, not identity.** It detects an edited or reordered record. It doesn't attest to who was at the keyboard — that needs a key, and a key needs somewhere safe to live.

---

## The thing worth taking away

The interesting engineering in agent safety isn't the model or the prompt. It's the boundary — where you put it, what it inspects, and which direction it fails in when something unexpected happens.

And it's worth having something adversarial read that boundary code, because you will be the last person to notice its holes. We had three safety mechanisms inspecting the wrong object and agreeing with each other. It took a reviewer with no stake in believing us to point that out.

---

**Code:** [R3108/TrueForge-Hackathon](https://github.com/R3108/TrueForge-Hackathon) · **The patient:** [R3108/cart-service](https://github.com/R3108/cart-service)

Built on [TrueForge](https://github.com/truefoundry/trueforge) for the TrueForge Agent Harness Hackathon. Reviewed throughout by [Qodo](https://www.qodo.ai/), which found more of our bugs than we'd like to admit.
