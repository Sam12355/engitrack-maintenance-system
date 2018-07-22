# 0001 - Gap recovery after a dropped connection

**Status:** implemented
**Date:** 2026-03

## Product request

> Engineers keep losing the connection on the office wifi. When it comes back the work order
> list looks fine, but they have told me twice now that they missed a note somebody added
> while they were disconnected.

## Clarified requirement

After a reconnection, the client must receive exactly the events it missed, in order, with
no duplicates applied and nothing silently skipped.

## Scope

**In scope:** buffering out-of-order arrivals, draining when a gap fills, dropping
duplicates, computing the resume point, bounding the buffer, signalling a refetch.

**Out of scope:** the socket transport, server-side replay, and rendering.

## Assumptions

- **The server allocates sequences inside the writing transaction.** Without that, two
  writers can pick the same number and nothing on the client can recover.
- **Replay may overlap with what was already received.** The client tolerates duplicates
  rather than requiring the server to compute the exact gap.
- **A hundred events ahead is enough buffer.** A guess. Past that, a single read is cheaper
  than streaming the catch-up.

## Acceptance criteria

- [x] AC1: a contiguous stream applies in order
- [x] AC2: an event ahead of the next sequence is buffered, not applied
- [x] AC3: when the gap fills, the buffer drains in one pass
- [x] AC4: a fully reversed stream ends up correctly ordered
- [x] AC5: an event at or below the applied point is dropped and counted
- [x] AC6: the resume point is the highest **applied** sequence, never the highest received
- [x] AC7: a replayed batch overlapping with live events loses nothing and duplicates nothing
- [x] AC8: a gap beyond the window signals a refetch instead of buffering without bound
- [x] AC9: state passed in is never mutated

## Security and privacy analysis

- **New data collected:** none. Events arrive already scoped by the server.
- **New authorisation decision:** none. Subscription authorisation is the server's job.
- **New attack surface:** a hostile stream could try to exhaust memory by never delivering
  the next sequence. AC8 bounds it.
- **Personal data near logs:** none. This module logs nothing.

## Test plan

One test per criterion, plus a scenario test that drops a connection mid-stream, replays
the gap, and resumes live delivery with an overlap.

AC6 gets the most attention. It is the only failure here that is silent, and a client that
resumes from the wrong point loses events with no error anywhere.

## Definition of Done

- [x] Criteria met, each with a test named after the situation
- [x] Tests written from this document before the implementation
- [x] Lint and type-check clean
- [x] No I/O, no clock read, no randomness introduced
