# Contributing

## Setup

```bash
pnpm install
pnpm verify     # lint, type-check, tests
```

Node 20 or newer and pnpm 9. Nothing else. If `pnpm verify` is not green on a clean
checkout, stop and report that rather than building on a broken baseline.

## The workflow

Specification first for anything beyond a one-line fix, written into `docs/specs/`: scope,
affected systems, acceptance criteria, security considerations, the tests it needs, and what
done means. It is not ceremony. It is what a reviewer reads the diff against, and without it
review collapses into "does this look reasonable".

Small commits, Conventional Commits, one logical change each.

## Conventions specific to this repository

**Everything stays pure.** No I/O, no timers, no `Date.now()`. Time is a parameter on
every function that needs it. That is what makes two engineers racing a unit test rather
than something reproduced by hand with two browser windows.

**Order by sequence, never timestamp.** If you are comparing `occurredAt` to decide
ordering, stop and read docs/CONCURRENCY.md.

**Anything that accumulates needs a bound** and a defined behaviour when it is reached.

## Tests

Named after the failure they prevent, not after the function they call. Failure paths are
covered at the same level as happy paths.

Tests are written **from the acceptance criteria, before the implementation**. A test
written afterwards asserts what the code does, which is not the same as what it should do.
That ordering has caught real bugs in this portfolio, several of which are named in the
test suites after the failure they prevent.

## Before opening a pull request

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Then read your own diff against the checklist in the pull request template.

