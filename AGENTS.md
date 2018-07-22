# Agent instructions

Agent-agnostic version of [CLAUDE.md](CLAUDE.md). The portfolio-wide process is in
[docs/ai/WORKFLOW.md](docs/ai/WORKFLOW.md).

## Setup

```bash
pnpm install
pnpm verify
```

If that is not green on a clean checkout, stop and report it rather than building on a
broken baseline.

## What this repository is

Pure decision logic for multi-engineer work order handling: event ordering, gap recovery,
claim leases, optimistic concurrency. No transport, no persistence, no UI. The running
console is `engitrack-platform`.

## Order of operations

1. Read the spec in `docs/specs/`. If there is none, write it and stop for review
2. Say which files you intend to change
3. Write the tests from the acceptance criteria, before the implementation
4. Implement
5. Run lint, type-check and tests, and paste the real output
6. Self-review against [docs/ai/REVIEW_CHECKLIST.md](docs/ai/REVIEW_CHECKLIST.md)

## Boundaries

| Action | Allowed |
|--------|---------|
| Add or fix tests | Yes |
| Refactor within a module | Yes |
| Add behaviour with a spec | Yes |
| Add a runtime dependency | Only with explicit approval |
| Change a public function signature | Only with explicit approval |
| Introduce I/O, a timer, or a clock read | Never. It is the thing this repository exists to avoid |
| Commit a secret | Never |
| `git push` | Never without being asked |
| Weaken a check to make a test pass | Never |
| Delete a failing test | Never |

## Repository-specific rules

**Everything stays pure.** Time is a parameter on every function that needs it.

**Order by sequence, never timestamp.**

**Resume from the highest applied sequence, not the highest received.**

**Buffer rather than apply out of order.**

**Every mutation guard checks version and lease.** They catch different failures.

**Anything that accumulates needs a bound.**

## Definition of done

- The spec exists and predates the implementation
- Lint, type-check and tests pass, output pasted
- The failure path is tested
- The diff is reviewable in one sitting
