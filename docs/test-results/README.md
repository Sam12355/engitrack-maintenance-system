# Recorded test output

Host: Windows 11, Node v24.11.1
Command: `npx jest --config jest.config.js --runInBand --verbose`
Run at: 2026-07-31T09:39:15Z

Two projects. `unit` covers the pure decision logic; `integration` boots the real Nest
application in-process and drives it over HTTP with supertest. Neither needs Postgres or
Redis running: the in-memory store enforces the same guarantees.

```console
PASS integration test/service.spec.ts
  the service runs
    √ answers a health check (726 ms)
    √ serves an empty queue (13 ms)
  claiming over HTTP
    √ lets an engineer claim an unheld workOrder (39 ms)
    √ returns 409 to the second engineer, naming the holder (15 ms)
    √ returns 409 for a stale version even when the workOrder is unclaimed (15 ms)
    √ lets another engineer take over once the lease lapses (23 ms)
    √ shows a lapsed claim as unclaimed in the queue (25 ms)
  mutations are guarded by both checks
    √ refuses a note from an engineer who has not claimed it (12 ms)
    √ refuses a note from an engineer whose claim was taken over (14 ms)
    √ refuses a note from the holder acting on a stale view (10 ms)
    √ accepts a note from the holder with a current version (10 ms)
  resume over HTTP
    √ returns only the events after the sequence the client has applied (30 ms)
    √ returns 404 for an workOrder that does not exist (6 ms)
  two engineers racing over HTTP
    √ gives the workOrder to exactly one of them (15 ms)
PASS unit src/event-stream.spec.ts
  in-order delivery
    √ applies a contiguous stream (1 ms)
  out-of-order delivery
    √ buffers an event that arrives early rather than rendering it in the wrong place (1 ms)
    √ drains the buffer as soon as the gap fills
    √ handles a whole stream delivered backwards (1 ms)
    √ reports which sequences are missing, for the banner
  duplicates
    √ drops a replay of something already applied
    √ drops a duplicate of something still in the buffer (1 ms)
    √ never applies the same sequence twice, however it arrives
  reconnection
    √ resumes from the highest applied sequence, not the highest received
    √ resumes from zero when nothing has been applied, meaning send everything
    √ applies a replayed batch and drains the buffer it was waiting on (1 ms)
    √ sorts a batch before applying, so a reversed replay still drains in one pass
    √ loses nothing across a drop and a resume
  unbounded buffering
    √ asks for a refetch when the gap grows past the replay window
    √ does not ask for a refetch for a small gap
  immutability
    √ does not mutate the state it was given
PASS unit src/claim.spec.ts
  claiming
    √ lets an engineer claim an unheld workOrder
    √ refuses a second engineer while the lease is live (1 ms)
    √ lets another engineer take over once the lease has lapsed
    √ treats the exact expiry instant as expired
    √ renews for the holder without emitting a second claim event (1 ms)
    √ rejects a claim carrying a stale version and reports the current one
  lease state
    √ reports an unclaimed workOrder as not held
    √ reports a lapsed lease as not held, so the workOrder gets picked up
    √ distinguishes held-by-me from held-by-anyone
  renewal timing
    √ does not ask for a renewal early in the lease
    √ asks for a renewal inside the renewal window (1 ms)
    √ never asks a non-holder to renew
  releasing
    √ lets the holder release
    √ refuses a release from somebody who does not hold it
    √ treats releasing an already-lapsed lease as success
  mutation authorisation
    √ allows a mutation from the holder with a current version
    √ blocks a mutation from someone who has not claimed it
    √ blocks a mutation from someone whose lease was taken over
    √ blocks a mutation from the holder acting on a stale view
  two engineers racing
    √ gives the workOrder to exactly one of them (1 ms)
    √ still refuses Bob once he reloads and retries with the current version
  messages shown to the engineer
    √ says who holds it and how long the claim has left
    √ tells a stale engineer to reload rather than showing an error code
    √ never shows a negative countdown for an already-lapsed claim
Test Suites: 3 passed, 3 total
Tests:       54 passed, 54 total
Snapshots:   0 total
Time:        6.255 s, estimated 10 s
Ran all test suites in 2 projects.
```

Re-recorded on 2026-07-31 after the domain rename. The previous transcript had its
identifiers rewritten along with the code, which would have left text no run ever printed.

## Not executed

| Item | Why |
|------|-----|
| Against real Postgres or Redis | The default adapters are in-memory. `docker compose up` starts both for driving it by hand |
| Docker image build | Built and run on 2026-07-31. `docker build -t engitrack-console .` then `docker run`; the container answers `/health` with `{"status":"ok"}` |
| Load test | No throughput number is claimed anywhere in this repository |
| Deployed anywhere | Never |
