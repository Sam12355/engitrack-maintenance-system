import { describe, expect, it } from 'vitest';

import {
  LEASE_MS,
  RENEW_BEFORE_MS,
  authoriseMutation,
  claim,
  explain,
  heldBy,
  isHeld,
  release,
  shouldRenew,
  type ClaimState,
} from './claim';

const NOW = 1_773_000_000_000;
const ALICE = 'operator-alice';
const BOB = 'operator-bob';

const unclaimed: ClaimState = {
  incidentId: 'incident-1',
  holderId: null,
  claimedAt: null,
  expiresAt: null,
  version: 0,
};

function claimedBy(operatorId: string, at = NOW, version = 1): ClaimState {
  return {
    incidentId: 'incident-1',
    holderId: operatorId,
    claimedAt: at,
    expiresAt: at + LEASE_MS,
    version,
  };
}

describe('claiming', () => {
  it('lets an operator claim an unheld incident', () => {
    const result = claim(unclaimed, ALICE, 0, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.holderId).toBe(ALICE);
    expect(result.state.expiresAt).toBe(NOW + LEASE_MS);
    expect(result.emitted).toBe('claimed');
    expect(result.state.version).toBe(1);
  });

  it('refuses a second operator while the lease is live', () => {
    const result = claim(claimedBy(ALICE), BOB, 1, NOW + 1_000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('held_by_other');
    if (result.error.kind !== 'held_by_other') return;
    // Naming the holder saves the losing operator a trip to Slack.
    expect(result.error.holderId).toBe(ALICE);
  });

  it('lets another operator take over once the lease has lapsed', () => {
    const result = claim(claimedBy(ALICE), BOB, 1, NOW + LEASE_MS + 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.holderId).toBe(BOB);
  });

  it('treats the exact expiry instant as expired', () => {
    // Somebody has to own the boundary. Expiry does, so an incident is never briefly
    // unavailable to everyone.
    const result = claim(claimedBy(ALICE), BOB, 1, NOW + LEASE_MS);
    expect(result.ok).toBe(true);
  });

  it('renews for the holder without emitting a second claim event', () => {
    const result = claim(claimedBy(ALICE), ALICE, 1, NOW + 60_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emitted).toBe('renewed');
    // The original claim time is preserved, so "handled by Alice since 19:45" stays true.
    expect(result.state.claimedAt).toBe(NOW);
    expect(result.state.expiresAt).toBe(NOW + 60_000 + LEASE_MS);
  });

  it('rejects a claim carrying a stale version and reports the current one', () => {
    const result = claim({ ...unclaimed, version: 7 }, ALICE, 3, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'stale_version', expected: 3, actual: 7 });
  });
});

describe('lease state', () => {
  it('reports an unclaimed incident as not held', () => {
    expect(isHeld(unclaimed, NOW)).toBe(false);
  });

  it('reports a lapsed lease as not held, so the incident gets picked up', () => {
    expect(isHeld(claimedBy(ALICE), NOW + LEASE_MS + 1)).toBe(false);
  });

  it('distinguishes held-by-me from held-by-anyone', () => {
    const state = claimedBy(ALICE);
    expect(heldBy(state, ALICE, NOW)).toBe(true);
    expect(heldBy(state, BOB, NOW)).toBe(false);
  });
});

describe('renewal timing', () => {
  it('does not ask for a renewal early in the lease', () => {
    expect(shouldRenew(claimedBy(ALICE), ALICE, NOW + 10_000)).toBe(false);
  });

  it('asks for a renewal inside the renewal window', () => {
    // Renewing at the last moment means any latency at all loses the lease.
    expect(shouldRenew(claimedBy(ALICE), ALICE, NOW + LEASE_MS - RENEW_BEFORE_MS + 1)).toBe(true);
  });

  it('never asks a non-holder to renew', () => {
    expect(shouldRenew(claimedBy(ALICE), BOB, NOW + LEASE_MS - 1_000)).toBe(false);
  });
});

describe('releasing', () => {
  it('lets the holder release', () => {
    const result = release(claimedBy(ALICE), ALICE, 1, NOW + 1_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.holderId).toBeNull();
  });

  it('refuses a release from somebody who does not hold it', () => {
    const result = release(claimedBy(ALICE), BOB, 1, NOW + 1_000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_holder');
  });

  it('treats releasing an already-lapsed lease as success', () => {
    // The operator's intent is already satisfied. An error here is noise.
    const result = release(claimedBy(ALICE), ALICE, 1, NOW + LEASE_MS + 1);
    expect(result.ok).toBe(true);
  });
});

describe('mutation authorisation', () => {
  it('allows a mutation from the holder with a current version', () => {
    expect(authoriseMutation(claimedBy(ALICE), ALICE, 1, NOW + 1_000).ok).toBe(true);
  });

  it('blocks a mutation from someone who has not claimed it', () => {
    const result = authoriseMutation(unclaimed, ALICE, 0, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_holder');
  });

  it('blocks a mutation from someone whose lease was taken over', () => {
    const result = authoriseMutation(claimedBy(BOB), ALICE, 1, NOW + 1_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('held_by_other');
  });

  it('blocks a mutation from the holder acting on a stale view', () => {
    // Version and lease catch different things: this operator holds the claim but is
    // looking at an incident that has moved on since they loaded it.
    const result = authoriseMutation(claimedBy(ALICE, NOW, 5), ALICE, 2, NOW + 1_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('stale_version');
  });
});

describe('two operators racing', () => {
  it('gives the incident to exactly one of them', () => {
    // Both consoles loaded version 0 and both pressed claim.
    const alice = claim(unclaimed, ALICE, 0, NOW);
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;

    // Bob's request arrives second, still carrying version 0.
    const bob = claim(alice.state, BOB, 0, NOW + 5);

    expect(bob.ok).toBe(false);
    if (bob.ok) return;
    // Version, not the lease, is what catches this one: Bob is acting on a view of the
    // incident that predates Alice's claim.
    expect(bob.error.kind).toBe('stale_version');
  });

  it('still refuses Bob once he reloads and retries with the current version', () => {
    const alice = claim(unclaimed, ALICE, 0, NOW);
    if (!alice.ok) return;

    const bob = claim(alice.state, BOB, alice.state.version, NOW + 5);

    expect(bob.ok).toBe(false);
    if (bob.ok) return;
    expect(bob.error.kind).toBe('held_by_other');
  });
});

describe('messages shown to the operator', () => {
  it('says who holds it and how long the claim has left', () => {
    const message = explain(
      { kind: 'held_by_other', holderId: ALICE, expiresAt: NOW + 90_000 },
      NOW,
    );
    expect(message).toContain(ALICE);
    expect(message).toContain('90s');
  });

  it('tells a stale operator to reload rather than showing an error code', () => {
    expect(explain({ kind: 'stale_version', expected: 1, actual: 4 }, NOW)).toMatch(/reload/i);
  });

  it('never shows a negative countdown for an already-lapsed claim', () => {
    const message = explain(
      { kind: 'held_by_other', holderId: ALICE, expiresAt: NOW - 5_000 },
      NOW,
    );

    // Asserting the message contains no hyphen would be wrong: the operator identifier
    // has one. The claim being tested is about the countdown, so read the countdown.
    const seconds = /lapses in (-?\d+)s/.exec(message)?.[1];
    expect(seconds).toBe('0');
  });
});
