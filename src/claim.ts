/**
 * Claim leases and optimistic concurrency.
 *
 * The problem this exists for: two operators open the same incident, both start working
 * it, and neither finds out until one of them writes over the other. Or one operator
 * claims it, closes their laptop, and the incident sits unavailable while nobody works it.
 *
 * A lease solves both. It is exclusive while held, and it expires on its own so an
 * abandoned incident returns to the queue without anyone intervening.
 *
 * Deliberately pure and free of the transport, so every case below is a unit test rather
 * than something you have to reproduce with two browser windows.
 */

export interface ClaimState {
  readonly incidentId: string;
  readonly holderId: string | null;
  readonly claimedAt: number | null;
  readonly expiresAt: number | null;
  /** Optimistic concurrency token. Every mutation must carry the version it saw. */
  readonly version: number;
}

export const LEASE_MS = 5 * 60_000;

/**
 * How long before expiry a holder should renew.
 *
 * Renewing at the last moment means any latency at all loses the lease. A minute is
 * generous enough that a slow request does not cost the claim and short enough that the
 * renewal traffic is negligible.
 */
export const RENEW_BEFORE_MS = 60_000;

export type ClaimError =
  | { readonly kind: 'held_by_other'; readonly holderId: string; readonly expiresAt: number }
  | { readonly kind: 'stale_version'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'not_holder'; readonly holderId: string | null };

export type ClaimResult =
  | { readonly ok: true; readonly state: ClaimState; readonly emitted: 'claimed' | 'renewed' | 'released' }
  | { readonly ok: false; readonly error: ClaimError };

export function isHeld(state: ClaimState, now: number): boolean {
  return state.holderId !== null && state.expiresAt !== null && state.expiresAt > now;
}

export function heldBy(state: ClaimState, operatorId: string, now: number): boolean {
  return isHeld(state, now) && state.holderId === operatorId;
}

export function shouldRenew(state: ClaimState, operatorId: string, now: number): boolean {
  if (!heldBy(state, operatorId, now)) return false;
  return (state.expiresAt ?? 0) - now <= RENEW_BEFORE_MS;
}

export function claim(
  state: ClaimState,
  operatorId: string,
  expectedVersion: number,
  now: number,
): ClaimResult {
  if (state.version !== expectedVersion) {
    return { ok: false, error: { kind: 'stale_version', expected: expectedVersion, actual: state.version } };
  }

  if (isHeld(state, now) && state.holderId !== operatorId) {
    // Naming the holder matters. "Someone else has this" sends the operator to Slack to
    // ask who; naming them lets the console show it directly.
    return {
      ok: false,
      error: {
        kind: 'held_by_other',
        holderId: state.holderId ?? 'unknown',
        expiresAt: state.expiresAt ?? now,
      },
    };
  }

  // Re-claiming your own incident extends the lease and emits nothing new. Operators keep
  // a tab open for a long time and should not lose an incident to their own idle, and a
  // timeline full of "claimed by the same person again" is noise.
  const isRenewal = state.holderId === operatorId;

  return {
    ok: true,
    emitted: isRenewal ? 'renewed' : 'claimed',
    state: {
      ...state,
      holderId: operatorId,
      claimedAt: isRenewal ? state.claimedAt : now,
      expiresAt: now + LEASE_MS,
      version: state.version + 1,
    },
  };
}

export function release(
  state: ClaimState,
  operatorId: string,
  expectedVersion: number,
  now: number,
): ClaimResult {
  if (state.version !== expectedVersion) {
    return { ok: false, error: { kind: 'stale_version', expected: expectedVersion, actual: state.version } };
  }

  // An expired lease is nobody's, so releasing it is a no-op rather than an error: the
  // operator's intent has already been satisfied.
  if (!isHeld(state, now)) {
    return { ok: true, emitted: 'released', state: { ...state, holderId: null, claimedAt: null, expiresAt: null } };
  }

  if (state.holderId !== operatorId) {
    return { ok: false, error: { kind: 'not_holder', holderId: state.holderId } };
  }

  return {
    ok: true,
    emitted: 'released',
    state: { ...state, holderId: null, claimedAt: null, expiresAt: null, version: state.version + 1 },
  };
}

/**
 * Guards a mutation: the caller must hold a live lease and must be up to date.
 *
 * Both checks are needed and they catch different things. The version catches an operator
 * acting on a stale view. The lease catches an operator acting on an incident somebody
 * else has taken over. Either alone leaves a real hole.
 */
export function authoriseMutation(
  state: ClaimState,
  operatorId: string,
  expectedVersion: number,
  now: number,
): { readonly ok: true } | { readonly ok: false; readonly error: ClaimError } {
  if (state.version !== expectedVersion) {
    return { ok: false, error: { kind: 'stale_version', expected: expectedVersion, actual: state.version } };
  }

  if (!heldBy(state, operatorId, now)) {
    return {
      ok: false,
      error: isHeld(state, now)
        ? { kind: 'held_by_other', holderId: state.holderId ?? 'unknown', expiresAt: state.expiresAt ?? now }
        : { kind: 'not_holder', holderId: null },
    };
  }

  return { ok: true };
}

/**
 * Message shown to the operator who lost the race.
 *
 * Written as a sentence rather than an error code because it appears in the interface. An
 * operator under time pressure needs to know what happened and what to do, not which
 * enum member was returned.
 */
export function explain(error: ClaimError, now: number): string {
  switch (error.kind) {
    case 'held_by_other': {
      const seconds = Math.max(0, Math.round((error.expiresAt - now) / 1000));
      return `Operator ${error.holderId} is handling this incident. Their claim lapses in ${seconds}s if they stop working on it.`;
    }
    case 'stale_version':
      return 'This incident changed while you were looking at it. Reload to see what happened before making changes.';
    case 'not_holder':
      return 'Claim this incident before making changes to it.';
    default: {
      const exhaustive: never = error;
      void exhaustive;
      return 'That action could not be completed.';
    }
  }
}
