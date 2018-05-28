# Working in this repository with an AI agent

The portfolio-wide process is in [docs/ai/WORKFLOW.md](docs/ai/WORKFLOW.md). This file is
the part specific to this repository.

## What this repository is

Pure decision logic for multi-operator incident handling: event ordering, gap recovery,
claim leases, optimistic concurrency. No transport, no persistence, no UI. That is the
boundary, and it is the first thing to preserve.

## Non-negotiables here

**Everything stays pure.** No I/O, no timers, no `Date.now()`, no `Math.random()`. Time
arrives as a parameter on every function that needs it. This is what makes "two operators
race for the same incident" a unit test rather than something you reproduce with two
browser windows and good timing. A change that introduces a dependency on the clock or the
network has broken the thing the repository exists for.

**Order by sequence, never by timestamp.** Device clocks are wrong, server timestamps lack
resolution, and neither tells a reconnecting client what it missed. If you find yourself
comparing `occurredAt` to decide ordering, stop.

**Resume from the highest *applied* sequence, not the highest *received*.** They differ
whenever something is buffered. Getting this wrong skips events permanently with no error
anywhere, which is the worst failure mode in this design. There is a test named after it.

**Buffer, never apply out of order.** An event that is not `appliedThrough + 1` is held.
Applying it renders a note above the action it describes.

**Every mutation guard checks version *and* lease.** They catch different failures and the
table in [docs/CONCURRENCY.md](docs/CONCURRENCY.md) says which. Removing either leaves a
real hole.

**Bounded buffers.** Anything that accumulates needs a limit and a defined behaviour when
it is hit. `MAX_BUFFER_AHEAD` exists because an unbounded buffer eventually kills the tab.

## Tests

Named after the failure they prevent, not after the function they call. `resumes from the
highest applied sequence, not the highest received` is a good name; `test resumePoint` is
not.

Failure paths are not optional. A concurrency mechanism with only happy-path tests is
decoration.

## Before you finish

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Paste the real output. Then read your diff against
[docs/ai/REVIEW_CHECKLIST.md](docs/ai/REVIEW_CHECKLIST.md), paying particular attention to
the concurrency section.

## Things that have gone wrong here

- A test asserting a message contained no hyphen, when the operator identifier has one.
  The test was wrong, not the code. Check what an assertion actually proves before
  trusting a red result.
- Reaching for a recursive helper that terminates by injecting synthetic state. It
  terminates and it is wrong; see the equivalent bug recorded in the playbook repository.
