# Contributing

Thanks for looking. This is a small codebase with an unusual property: some of it is a control, and the rest of it is a program. The two are held to different standards, and it is worth knowing which you are touching before you start.

## Getting set up

```bash
npm install
npm run typecheck
npm test
```

No build step and no test framework: the CLIs run TypeScript directly under `node --experimental-strip-types`, and the tests are `node:test`. The only runtime dependency is the TrueForge SDK. Please keep it that way — a safety control that pulls in a dependency tree is a safety control nobody can audit.

You do not need a TrueForge server, a model key, or a connector to work on the perimeter, the tripwire, the journal, or the renderer. Everything under `src/runtime/` is pure and directly testable, which is deliberate.

## The control plane

These files decide what the agent is allowed to do:

```
src/agent/spec.ts        the approval gate itself
src/runtime/approvals.ts the human prompt, and how it fails
src/runtime/perimeter.ts where the agent may write
src/runtime/secrets.ts   what the agent may write
src/config.ts            how the above are configured
.github/workflows/ci.yml what verifies all of it
```

Changes here need a test that would fail without them. Not "a test that exercises the code" — a test that describes the *attack*, the way `perimeter.test.ts` writes down what happens when the agent tries to patch its own approval gate. If you cannot phrase the failing case, the change probably belongs somewhere else.

Widening a boundary is a separate pull request from anything else. A perimeter change buried in a refactor is the exact shape of the problem this project exists to talk about.

## The rest

`src/cli/`, `src/runtime/render.ts`, and `docs/` are ordinary code. Normal care, no ceremony.

[`R3108/cart-service`](https://github.com/R3108/cart-service) is the service the agent repairs, in a separate repository so the agent can never reach this one. It is meant to contain a realistic bug — please don't fix it.

## Style

The code is commented at the level of *why*, not *what*. Where a decision could reasonably have gone the other way — fail closed vs. prompt, refuse vs. warn, block vs. allow on an empty allowlist — the comment says which way it went and what it costs. Matching that is more useful than matching any formatting rule.

Two conventions worth keeping:

- **A denial always carries a reason the agent can read.** It is what lets it explain itself instead of retrying blindly.
- **Nothing that reports a leak may quote the leak.** Redact in the finding, not at the point of display.

## Pull requests

Every change lands through a pull request reviewed by [Qodo](https://www.qodo.ai/); no direct commits to `main`. CI runs typecheck, tests, the perimeter assertions, and a check that the harness still refuses to target itself. All four must be green.

If your change touches the perimeter, add the paths you care about to the `--expect-blocked` / `--expect-allowed` lists in `.github/workflows/ci.yml`. That file is where this project writes down what it promises.
