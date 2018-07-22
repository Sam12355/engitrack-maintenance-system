# Threat model

Scoped to this module. The product-level model is in
`engitrack-platform/THREAT_MODEL.md`; this covers what a concurrency layer can get
wrong.

## What is worth protecting

The integrity of the work order record, and an engineer's confidence that what they are
looking at is current. A console that silently shows stale state is worse than one that
shows an error, because the engineer acts on it.

## T1. Silent event loss

**Vector:** a client resumes from the wrong sequence after a reconnect and permanently
skips events. Nothing errors; the timeline is simply missing entries.

**Why it matters most:** every other failure here is loud. This one is silent, and an
engineer working from an incomplete timeline may conclude a work order is quieter than it is.

**Mitigation:** resume from the highest **applied** sequence, never the highest received.
Buffered events do not advance the resume point. Tested by name.

**Residual:** a host that computes its own resume point rather than calling `resumePoint`
reintroduces this. The function exists so nobody has to.

## T2. Concurrent overwrite

**Vector:** two engineers act on the same work order and one silently overwrites the other.

**Mitigation:** version check on every mutation, plus a lease. The four-case table in
docs/CONCURRENCY.md shows why both are needed.

**Residual:** none within this module. The database has to actually enforce the version.

## T3. Lease monopolisation

**Vector:** an engineer holds a work order indefinitely, deliberately or by leaving a tab
open.

**Mitigation:** leases expire without intervention. Re-claiming extends but does not create
a permanent hold, and expiry is evaluated against the caller's clock on every check.

**Residual:** a determined engineer can renew forever. Auditable, not prevented, and
preventing it needs a policy decision rather than a technical one.

## T4. Memory exhaustion from a hostile or broken stream

**Vector:** a stream that never delivers the next sequence, so everything buffers.

**Mitigation:** `MAX_BUFFER_AHEAD` bounds it and signals a refetch.

## T5. Clock manipulation

**Vector:** the caller passes a `now` derived from client-supplied time, so an engineer
extends their own lease or makes another's look expired.

**Mitigation:** none in this module. It cannot distinguish a trustworthy clock from an
untrustworthy one, so the requirement to pass server time is documented in SECURITY.md and
stated as an assumption rather than assumed silently.

## T6. Ordering confusion from duplicate identifiers

**Vector:** two different events sharing a sequence number.

**Mitigation:** the second is dropped as a duplicate, and the database's unique constraint
on `(workOrder_id, sequence)` is what makes it impossible upstream. This module is
defensive, not authoritative, about that.

## Out of scope

Authentication, transport security, persistence, denial of service against a host, and
anything about real emergency services, which the product deliberately never contacts.
