# Security

Nothing here is deployed and there is no user data. This describes the security properties
of the logic itself, which is where the interesting content is for a concurrency module.

## Reporting

Open an issue. Do not include real credentials or real location data.

## What this module is responsible for

**Authorisation decisions, not authorisation enforcement.** `authoriseMutation` decides
whether an engineer may act. The host application enforces that decision, and the database
enforces the version with `WHERE version = $n`. Both layers are required: a decision nobody
acts on is decoration, and enforcement without a decision function ends up scattered across
route handlers where it is easy to miss one.

## Properties that hold

| Property | How |
|----------|-----|
| An engineer cannot act on a work order held by someone else | `authoriseMutation` fails `held_by_other` |
| An engineer cannot act on a stale view, even holding the claim | `authoriseMutation` fails `stale_version` |
| A lapsed lease grants nothing | `isHeld` is time-based and takes `now` as a parameter |
| A claim cannot be held indefinitely by an absent engineer | Leases expire; there is no infinite variant |
| A client cannot be starved of events by a hostile ordering | Buffering plus resume-from-applied recovers any interleaving |
| A malformed stream cannot exhaust memory | `MAX_BUFFER_AHEAD` bounds the buffer and signals a refetch |

Each has a test.

## What this module deliberately does not do

- **Authenticate.** It never sees a token. Engineer identity arrives as a string that the
  host has already verified.
- **Enforce.** It returns decisions. A host that ignores them is not protected by them.
- **Persist.** No storage, so no injection surface and no encryption question.
- **Log.** Nothing is logged, so nothing sensitive can leak through a log. The host decides
  what to record, and the portfolio rule is identifiers only.

## Residual risks

- **A host that calls `claim` without calling `authoriseMutation`** on subsequent writes
  gets the lease and loses the version check. The API shape makes that awkward rather than
  impossible.
- **Clock supplied by the caller.** Every time-dependent decision trusts the `now` it is
  given. A host passing client-supplied time would let an engineer extend their own lease.
  The host must pass server time. Stated here because it is the one assumption this module
  cannot verify for itself.
- **No fairness.** Repeated claim and release can monopolise a work order. Auditable, not
  prevented.
