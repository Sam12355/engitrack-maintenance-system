# Testing

## Running it

```bash
pnpm test          # 40 tests, about a second
pnpm test:watch
```

No database, no browser, no Docker, no network. The logic under test is pure, which is why
two operators racing for the same incident is a unit test here rather than something you
reproduce by hand with two browser windows and good timing.

## What is covered

| Area | Cases | Covering |
|------|-------|----------|
| In-order delivery | 1 | The baseline |
| Out-of-order | 4 | Buffering, draining, a fully reversed stream, gap reporting |
| Duplicates | 3 | Replay of applied, replay of buffered, chaotic arrival order |
| Reconnection | 5 | Resume-point correctness, batch replay, nothing lost across a drop |
| Bounded buffering | 2 | Refetch past the window, no refetch for a small gap |
| Claim | 6 | Take, refuse, lapse, renew, exact boundary, stale version |
| Lease timing | 3 | Renewal window, non-holder never renews |
| Authorisation | 4 | Holder and current, non-holder, taken over, stale view |
| Racing | 2 | Both claim from version 0; exactly one wins, twice, for different reasons |
| Messages | 3 | Names the holder, gives a countdown, never a negative one |
| Immutability | 1 | State passed in is never mutated |

## The three that matter most

**"resumes from the highest applied sequence, not the highest received".** Getting this
wrong skips events permanently with no error anywhere. Every other failure in this module
is loud; this one is silent, which makes it both the most dangerous and the most worth a
test named after the situation rather than after the function.

**"still refuses Bob once he reloads and retries with the current version".** Proves the
lease and the version catch different things. A design with only one of them passes the
first racing test and fails this one.

**"treats the exact expiry instant as expired".** Somebody has to own the boundary, or an
incident is briefly claimable by nobody.

## Conventions

Tests are named after the failure they prevent. The output of `pnpm test` should read as a
description of how the module behaves under adverse conditions.

Time is a parameter everywhere, so there is no sleep in the suite and nothing is flaky on a
loaded machine.

Tests are written from the acceptance criteria before the implementation exists. Written
afterwards, a test asserts what the code does, which is not the same as what it should do.

## Deliberately not tested

- **The transport.** Socket.IO reconnection is a solved problem in Socket.IO. This module
  supplies the resume point, and that is what is tested.
- **Rendering.** There is no UI here.
- **Map performance.** The point-thinning routine lives in the flagship web app with its
  own tests. There is no benchmark anywhere in this portfolio, because there is no number
  I could honestly publish.

## One test that was wrong

A message test asserted the output contained no hyphen, as a way of proving the countdown
was never negative. The operator identifier contains a hyphen, so it failed against
perfectly correct code. The assertion was rewritten to read the countdown value directly.

Recorded because a red test is not automatically a bug in the code, and treating it as one
is how a correct implementation gets "fixed".
