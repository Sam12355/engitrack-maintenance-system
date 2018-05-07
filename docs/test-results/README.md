# Recorded test output

Host: Windows 11, Node v24.11.1
Command: `npx vitest run`
Run at: 2026-07-31T05:12:24Z

No database, no browser, no Docker. The logic under test is pure.

```console
 RUN  v2.1.9 C:/Users/slaks/Documents/mygit/guardianlink-incident-console
 ✓ src/claim.spec.ts > claiming > lets an operator claim an unheld incident
 ✓ src/claim.spec.ts > claiming > refuses a second operator while the lease is live
 ✓ src/claim.spec.ts > claiming > lets another operator take over once the lease has lapsed
 ✓ src/claim.spec.ts > claiming > treats the exact expiry instant as expired
 ✓ src/claim.spec.ts > claiming > renews for the holder without emitting a second claim event
 ✓ src/claim.spec.ts > claiming > rejects a claim carrying a stale version and reports the current one
 ✓ src/claim.spec.ts > lease state > reports an unclaimed incident as not held
 ✓ src/claim.spec.ts > lease state > reports a lapsed lease as not held, so the incident gets picked up
 ✓ src/claim.spec.ts > lease state > distinguishes held-by-me from held-by-anyone
 ✓ src/claim.spec.ts > renewal timing > does not ask for a renewal early in the lease
 ✓ src/claim.spec.ts > renewal timing > asks for a renewal inside the renewal window
 ✓ src/claim.spec.ts > renewal timing > never asks a non-holder to renew
 ✓ src/claim.spec.ts > releasing > lets the holder release
 ✓ src/claim.spec.ts > releasing > refuses a release from somebody who does not hold it
 ✓ src/claim.spec.ts > releasing > treats releasing an already-lapsed lease as success
 ✓ src/claim.spec.ts > mutation authorisation > allows a mutation from the holder with a current version
 ✓ src/claim.spec.ts > mutation authorisation > blocks a mutation from someone who has not claimed it
 ✓ src/claim.spec.ts > mutation authorisation > blocks a mutation from someone whose lease was taken over
 ✓ src/claim.spec.ts > mutation authorisation > blocks a mutation from the holder acting on a stale view
 ✓ src/claim.spec.ts > two operators racing > gives the incident to exactly one of them
 ✓ src/claim.spec.ts > two operators racing > still refuses Bob once he reloads and retries with the current version
 ✓ src/claim.spec.ts > messages shown to the operator > says who holds it and how long the claim has left
 ✓ src/claim.spec.ts > messages shown to the operator > tells a stale operator to reload rather than showing an error code
 ✓ src/claim.spec.ts > messages shown to the operator > never shows a negative countdown for an already-lapsed claim
 ✓ src/event-stream.spec.ts > in-order delivery > applies a contiguous stream
 ✓ src/event-stream.spec.ts > out-of-order delivery > buffers an event that arrives early rather than rendering it in the wrong place
 ✓ src/event-stream.spec.ts > out-of-order delivery > drains the buffer as soon as the gap fills
 ✓ src/event-stream.spec.ts > out-of-order delivery > handles a whole stream delivered backwards
 ✓ src/event-stream.spec.ts > out-of-order delivery > reports which sequences are missing, for the banner
 ✓ src/event-stream.spec.ts > duplicates > drops a replay of something already applied
 ✓ src/event-stream.spec.ts > duplicates > drops a duplicate of something still in the buffer
 ✓ src/event-stream.spec.ts > duplicates > never applies the same sequence twice, however it arrives
 ✓ src/event-stream.spec.ts > reconnection > resumes from the highest applied sequence, not the highest received
 ✓ src/event-stream.spec.ts > reconnection > resumes from zero when nothing has been applied, meaning send everything
 ✓ src/event-stream.spec.ts > reconnection > applies a replayed batch and drains the buffer it was waiting on
 ✓ src/event-stream.spec.ts > reconnection > sorts a batch before applying, so a reversed replay still drains in one pass
 ✓ src/event-stream.spec.ts > reconnection > loses nothing across a drop and a resume
 ✓ src/event-stream.spec.ts > unbounded buffering > asks for a refetch when the gap grows past the replay window
 ✓ src/event-stream.spec.ts > unbounded buffering > does not ask for a refetch for a small gap
 ✓ src/event-stream.spec.ts > immutability > does not mutate the state it was given
 Test Files  2 passed (2)
      Tests  40 passed (40)
   Start at  07:12:27
   Duration  1.07s (transform 363ms, setup 0ms, collect 401ms, tests 20ms, environment 0ms, prepare 549ms)
```
