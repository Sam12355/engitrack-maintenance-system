# Concurrency, ordering and recovery

The technical write-up. Each section states the problem, the mechanism, and what it costs.

## 1. Event ordering

### The problem

Three independent things break timestamp ordering, and any one of them is enough.

Device clocks are wrong. A phone that has been offline can be minutes out, so ordering by
when the client says something happened produces an order that never happened.

Server timestamps have insufficient resolution. Two events written in the same millisecond
have no defined order, and the operator sees "resolved" above "note added".

Neither tells a reconnecting client what it missed. Asking for everything since a time
either duplicates or races the clock.

### The mechanism

A monotonic per-incident sequence, allocated inside the transaction that writes the event.
Not by the application: if the application picked the number, two concurrent writers could
both choose 7 and the timeline would fork. Postgres does this with a per-incident sequence
and a unique constraint on `(incident_id, sequence)`.

Both fields are kept. `occurredAt` is what gets displayed; `sequence` is what everything
orders by. That is why a backlog flushed twenty minutes late shows the times things
actually happened while still sorting correctly.

### The cost

A sequence per incident is a hot row under concurrent writes to one incident. Fine at a
handful of writes a second, which is what a busy incident produces.

## 2. Out-of-order arrival

### The problem

Networks reorder. Applying event 9 while 8 is missing renders a note above the action it
describes, which is worse than not rendering it yet: the operator reads a timeline that
misrepresents what happened.

### The mechanism

An event that is not `appliedThrough + 1` is buffered, not applied. When the gap fills,
the buffer drains in one pass. `applyBatch` sorts before applying, so a replay delivered
in reverse drains immediately rather than sitting in the buffer until its last element
arrives.

### The cost

The buffer is unbounded in principle, so it is bounded in practice: past
`MAX_BUFFER_AHEAD`, the stream reports `needsRefetch` and the caller does a single read
instead. Without that, a client that missed a thousand events holds a thousand items that
can never drain until the tab dies.

## 3. Duplicates

### The problem

After a reconnect the replay overlaps with what arrived before the drop. At-least-once
delivery means the same event arrives twice in normal operation, not as an error.

### The mechanism

Drop anything at or below `appliedThrough`, and anything already in the buffer. Duplicate
delivery becomes a counter, not a bug. That in turn is what lets the server be generous
about replay: it does not have to compute exactly what the client missed, only a superset.

### The cost

A counter that grows. Useful as a diagnostic, and a persistently high number is a signal
that something upstream is re-sending more than it needs to.

## 4. Reconnection

### The problem

The client has a partial view and does not know what it missed. Asking for the wrong thing
either floods it or skips events permanently.

### The mechanism

Resume from the highest **applied** sequence, never the highest **received**. Those differ
whenever something is buffered, and the difference is exactly the gap.

```ts
// Applied 1 and 2. Received 9, which is buffered.
resumePoint(state) // 2, not 9
```

Resuming from 9 would skip 3 through 8 for ever, and nothing downstream would notice: the
timeline would simply be missing events, ordered correctly, with no error anywhere. That is
the most dangerous kind of bug in this design and it is why the test for it is written as a
scenario rather than an assertion about a getter.

### The cost

A client that has been away for a long time gets told to refetch. One extra round trip on
the connection that was already struggling, in exchange for bounded memory.

## 5. Claim leases

### The problem

Two operators work the same incident and neither knows. Or one claims it, walks away, and
it sits unavailable.

### The mechanism

A lease: exclusive while held, self-expiring after five minutes. Re-claiming your own
extends it silently.

### Why version and lease are both needed

This is the part worth reading twice. They catch different failures:

| Situation | Version | Lease | Result |
|-----------|---------|-------|--------|
| Bob acts on an incident he loaded before Alice claimed it | stale | would also fail | Caught by version, which fires first |
| Bob reloads, then tries to claim what Alice holds | current | held by Alice | Caught by lease |
| Alice holds the claim but her tab is showing an old version | stale | held by her | Caught by version. She holds the claim and is still wrong |
| Alice held it, Bob took over after expiry, Alice acts | current | held by Bob | Caught by lease. She is up to date and no longer entitled |

The third and fourth rows are the interesting ones. A design with only a lease misses the
third; a design with only a version misses the fourth. Both rows have a test.

### The cost

Two things to send on every mutation and two ways to be refused. The refusal messages are
written as sentences rather than error codes for that reason: an operator under pressure
needs to know what happened and what to do next.

## 6. What is not solved here

**Fairness.** An operator who claims and releases repeatedly can monopolise an incident.
Visible in the audit log, not prevented.

**Split brain across regions.** Single-region. Two regions each allocating sequences for
the same incident would need a different mechanism entirely.

**Causal ordering across incidents.** Sequences are per incident. Two incidents have no
defined relative order, and nothing in the product needs one.

**Presence.** Whether an operator is currently looking at an incident, as distinct from
holding a lease. Useful, out of scope.
