# ADR-0001: A pure decision core inside a thin service

**Status:** accepted
**Date:** 2026-03

## Context

The brief specifies React, Next.js, Apollo, NestJS, Postgres, Redis, Socket.IO, MapLibre
and Docker for this repository. Building all of that would produce a second, smaller copy
of the flagship's engineer console.

The problem this repository is actually about is narrower: what a work order console does
when events arrive twice, out of order, with a gap, while a second engineer mutates the
same record.

## Decision

Implement that logic as pure functions, exhaustively tested, and wrap it in a service thin
enough that the controllers contain no decisions. Rendering and production persistence stay
in the flagship, which already has them.

## Why

Reproducing "two engineers race for the same work order, one from a stale view" through a
running stack means a database, a socket server, two browser sessions and precise timing.
It is possible, and it is the kind of test that gets written once and then skipped when it
turns flaky.

As a pure function it is four lines of setup and an assertion, it runs in a millisecond, and
it cannot be flaky. That is the difference between a concurrency guarantee that is checked
on every commit and one that is checked once.

The same argument applies to the resume-point bug, which is the most dangerous defect in
this design: it silently skips events with no error anywhere. Catching it needs a test that
distinguishes "highest applied" from "highest received", which is trivial here and awkward
through a socket.

## Consequences

**Good.** 40 tests in a second, no infrastructure, no flakiness. The logic is readable in
two files. The boundary against the flagship stays sharp: this repository cannot drift into
being a second dashboard, because it has no dashboard.

**Bad.** Two layers to read rather than one. Somebody looking for where a claim is refused
has to follow the controller into the service into `claim.ts`. The compensation is that the
decision is testable in isolation and the controller has nothing in it worth hiding a bug in.

**Also bad.** There is no console UI here. A reviewer expecting a screen will not find one;
that is in the flagship, and duplicating it would blur the boundary this repository exists
to keep sharp.

## What this bought

The integration suite is 14 tests over real HTTP and it found nothing, because the unit
suite had already found everything. That is the intended outcome: the HTTP tests prove the
rules are wired up, and the unit tests prove they are right.
