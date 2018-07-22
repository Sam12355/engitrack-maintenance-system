# engitrack-maintenance-system

**What happens when two engineers work the same work order at once, on a connection that
keeps dropping, with events arriving in the wrong order.**

> Part of the [portfolio](../PORTFOLIO.md). A demonstration, not a system anybody schedules
> maintenance with.

> **A reconstruction, not an employer's codebase.** I worked on engineering maintenance
> software in 2015 and 2016, and the console was where the interesting failures lived: two
> engineers claiming the same job, a laptop lid closing on a held record, a site connection
> that dropped every few minutes. This repository is that problem rebuilt from scratch. No
> code, schema or copy came from an employer.
>
> **The original was ASP.NET MVC 5 and C#**, on SQL Server with Entity Framework 6, jQuery
> and Bootstrap 3 on the front end, and SignalR for the live updates. What is here is a
> modern TypeScript reconstruction. Porting it back to 2015 tooling would have been a large
> rewrite that demonstrated nothing about the concurrency problem, which is the whole point
> of the repository, so I did not do it. Where the era matters to a decision, the document
> says so.

The flagship platform answers "can an engineer work a work order". This repository answers
the harder question underneath it, and takes that one problem as far as it goes.

[![tests](https://img.shields.io/badge/tests-54%20passing-brightgreen)](docs/test-results/)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

---

## The problem

A work order console has properties a normal CRUD screen does not:

- **Two engineers, one work order.** Both open it, both start working, and without something
  in the way neither finds out until one overwrites the other.
- **An engineer who walks away.** A claim with no expiry means a work order sits
  unavailable while nobody works it. On a plant floor that is a job nobody is doing.
- **A flaky connection.** Sockets drop while a job is open. When one comes back, the client has
  a partial view and does not know what it missed.
- **Out-of-order delivery.** Mobile and proxy networks reorder. Rendering an engineer note
  above the action it describes is worse than not rendering it yet.
- **Wrong clocks.** Device and server time disagree, so timestamps cannot order anything.

Each one has a specific mechanism here, and each mechanism has tests that describe the
failure it prevents rather than the method it calls.

## How it works

```mermaid
flowchart TB
    subgraph client["Client"]
        BUF["Sequence buffer<br/>hold, drain, drop duplicates"]
        RESUME["Resume point<br/>highest applied, never highest received"]
    end
    subgraph server["Server"]
        SEQ["Per-work order sequence<br/>allocated inside the write transaction"]
        LEASE["Claim lease<br/>exclusive, self-expiring"]
        VER["Version check<br/>WHERE version = n"]
    end
    SEQ --> BUF
    BUF --> RESUME
    RESUME -->|"I have up to 41"| SEQ
    LEASE --> VER
```

### Event ordering

Events carry a per-work order sequence allocated by the database inside the writing
transaction, so two concurrent writers cannot both decide they are number seven. The
client orders by it and never by a timestamp.

An event that is not the next one is **buffered, not applied**. When the gap fills, the
buffer drains in one pass. Anything at or below the highest applied sequence is dropped,
which makes duplicate delivery after a reconnect completely harmless.

The buffer is bounded. A client that has missed more than the replay window is told to
refetch rather than accumulating events that can never drain.

### Reconnection

On reconnect the client sends the highest sequence it has **applied**, not the highest it
has received. Those differ whenever something is sitting in the buffer, and sending the
wrong one skips events for ever. There is a test for exactly that.

### Claim leases

A claim is exclusive while held and expires on its own after five minutes. Re-claiming your
own work order extends the lease and emits nothing new, because engineers keep a tab open for
a long time and a timeline full of "claimed by the same person again" is noise.

Mutations are guarded by **two** independent checks:

- **Version**: is this engineer acting on a current view of the work order?
- **Lease**: does this engineer currently hold it?

They catch different failures. An engineer can hold the claim and still be looking at a
stale work order; another can be up to date and have had the claim taken from them. Either
check alone leaves a real hole, and there is a test per case.

## Running it

```bash
pnpm install
pnpm verify        # lint, type-check, 54 tests
pnpm dev           # http://localhost:3002
```

No database, no Redis, no browser. The service runs on in-memory adapters that enforce the
same version and sequence guarantees the Postgres ones do, so two engineers racing is a test
rather than something you reproduce by hand with two browser windows and good timing.

`docker compose up -d` starts Postgres and Redis if you want to drive it against real
backing stores.

## Test coverage

54 tests, all passing: 40 unit tests over the decision logic and 14 that drive the same
rules over real HTTP against the running service. Each is named after the failure it
prevents.

| Area | Cases |
|------|-------|
| In-order delivery | Contiguous application |
| Out-of-order | Buffering, draining, a fully reversed stream, gap reporting |
| Duplicates | Replay of applied, replay of buffered, chaotic arrival order |
| Reconnection | Resume point correctness, batch replay, nothing lost across a drop |
| Bounded buffering | Refetch past the window, no refetch for a small gap |
| Claim | Take, refuse, lapse, renew, boundary instant, stale version |
| Lease timing | Renewal window, non-holder never renews |
| Authorisation | Holder with current version, non-holder, taken over, stale view |
| Racing | Both claim from version 0; exactly one wins, twice, for different reasons |
| Messages | Names the holder, gives a countdown, never shows a negative one |
| Over HTTP | Health, queue, claim, 409 conflicts, lapsed lease, both mutation guards, resume delta, two engineers racing concurrently |

Recorded output: [docs/test-results/](docs/test-results/).

## Why not just reuse the flagship console

The flagship's console is a product feature: it shows a queue, opens a work order, and
lets an engineer work it. It solves the concurrency problem well enough to ship.

This repository takes the same problem and asks what happens at the edges: at the exact
instant a lease expires, when a batch arrives reversed, when the resume point is computed
from the wrong number, when two requests carry the same stale version. Those are the cases
that are tedious to reproduce and easy to get wrong, and they are the whole content here.

## Deliberately not here

Accounts, mobile apps, subscriptions, billing, notification delivery, AWS. Devices are a
generator script. If it is not about two engineers touching one work order at the same time,
or about events arriving in the wrong order, it does not belong.

## Known limitations

- **No UI.** The queue view-model lives in the flagship web app. Adding a second copy here
  would blur the boundary this repository exists to keep sharp.
- **Only the in-memory store is implemented.** The Postgres adapter is described in
  ARCHITECTURE.md but not written. The port exists and the in-memory implementation
  enforces the same version check, which is what makes the racing tests meaningful.
- **The lease duration is a judgement call.** Five minutes, with no data to tune it
  against. Stated as a guess rather than presented as a finding.
- **No fairness.** An engineer who repeatedly claims and releases can monopolise a
  work order. Visible in the audit log, not prevented.
- **Never deployed, and no Docker image has been built.** The Dockerfile and Compose file
  are written and neither has been run on this machine.

## Further reading

- [docs/CONCURRENCY.md](docs/CONCURRENCY.md): the full write-up, including why version
  and lease are both needed
- [ARCHITECTURE.md](ARCHITECTURE.md)

## Suggested repository metadata

**Description:** Multi-engineer work order console: event ordering, claim leases, optimistic
concurrency and reconnection recovery, with tests for every failure mode.

**Topics:** `typescript` `concurrency` `optimistic-locking` `event-sourcing` `websockets`
`distributed-systems` `testing` `portfolio`

## Licence

[MIT](LICENSE).
