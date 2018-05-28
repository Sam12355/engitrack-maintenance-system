import { Inject, Injectable } from '@nestjs/common';

import {
  applyBatch,
  applyEvent,
  emptyStream,
  hasGap,
  resumePoint,
  type IncidentEvent,
  type StreamState,
} from './event-stream';
import {
  authoriseMutation,
  claim,
  isHeld,
  release,
  shouldRenew,
  type ClaimError,
  type ClaimState,
} from './claim';

/**
 * The service around the pure decision logic.
 *
 * Everything interesting still happens in `event-stream.ts` and `claim.ts`, which take no
 * dependencies and read no clock. This layer supplies persistence and time, and that split
 * is what lets "two operators race for the same incident" stay a unit test rather than
 * something reproduced with two browser windows and good timing.
 */

export const INCIDENT_STORE = Symbol('IncidentStore');
export const CLOCK = Symbol('Clock');

export interface IncidentRecord {
  readonly id: string;
  readonly claim: ClaimState;
  readonly events: readonly IncidentEvent[];
}

/**
 * Persistence port. The in-memory adapter is the default and is what the tests use; the
 * Postgres adapter implements the same contract with a version check in the UPDATE.
 */
export interface IncidentStore {
  find(incidentId: string): Promise<IncidentRecord | null>;
  create(incidentId: string): Promise<IncidentRecord>;
  saveClaim(incidentId: string, next: ClaimState, expectedVersion: number): Promise<boolean>;
  appendEvent(incidentId: string, event: Omit<IncidentEvent, 'sequence'>): Promise<IncidentEvent>;
  eventsAfter(incidentId: string, sequence: number, limit: number): Promise<IncidentEvent[]>;
  list(limit: number, cursor: string | null): Promise<{ items: IncidentRecord[]; nextCursor: string | null }>;
}

export interface Clock {
  now(): number;
}

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ClaimError | { kind: 'not_found' } };

@Injectable()
export class IncidentService {
  constructor(
    @Inject(INCIDENT_STORE) private readonly store: IncidentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async claimIncident(
    incidentId: string,
    operatorId: string,
    expectedVersion: number,
  ): Promise<ServiceResult<ClaimState>> {
    const record = await this.store.find(incidentId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const decision = claim(record.claim, operatorId, expectedVersion, this.clock.now());
    if (!decision.ok) return decision;

    // The store performs the version check again in its UPDATE. Deciding and enforcing are
    // separate on purpose: the decision is testable without a database, and the database
    // is what makes it atomic against a concurrent writer.
    const saved = await this.store.saveClaim(incidentId, decision.state, expectedVersion);
    if (!saved) {
      const current = await this.store.find(incidentId);
      return {
        ok: false,
        error: {
          kind: 'stale_version',
          expected: expectedVersion,
          actual: current?.claim.version ?? expectedVersion,
        },
      };
    }

    if (decision.emitted === 'claimed') {
      await this.store.appendEvent(incidentId, {
        incidentId,
        type: 'incident.operator_claimed',
        occurredAt: new Date(this.clock.now()).toISOString(),
        payload: { operatorId },
      });
    }

    return { ok: true, value: decision.state };
  }

  async releaseIncident(
    incidentId: string,
    operatorId: string,
    expectedVersion: number,
  ): Promise<ServiceResult<ClaimState>> {
    const record = await this.store.find(incidentId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const decision = release(record.claim, operatorId, expectedVersion, this.clock.now());
    if (!decision.ok) return decision;

    await this.store.saveClaim(incidentId, decision.state, expectedVersion);
    await this.store.appendEvent(incidentId, {
      incidentId,
      type: 'incident.operator_released',
      occurredAt: new Date(this.clock.now()).toISOString(),
      payload: { operatorId },
    });

    return { ok: true, value: decision.state };
  }

  /**
   * A note, or any other operator mutation.
   *
   * Guarded by both the version and the lease. They catch different failures: an operator
   * can hold the claim and still be looking at a stale incident, and another can be up to
   * date and have had the claim taken from them.
   */
  async addNote(
    incidentId: string,
    operatorId: string,
    note: string,
    expectedVersion: number,
  ): Promise<ServiceResult<IncidentEvent>> {
    const record = await this.store.find(incidentId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const allowed = authoriseMutation(record.claim, operatorId, expectedVersion, this.clock.now());
    if (!allowed.ok) return allowed;

    const event = await this.store.appendEvent(incidentId, {
      incidentId,
      type: 'incident.operator_note_added',
      occurredAt: new Date(this.clock.now()).toISOString(),
      payload: { operatorId, note },
    });

    return { ok: true, value: event };
  }

  /**
   * Gap recovery for a reconnecting client.
   *
   * The client sends the highest sequence it has **applied**. Anything above that is
   * replayed. Past the replay window it is told to refetch rather than being sent a
   * partial stream it would have to stitch together.
   */
  async resume(
    incidentId: string,
    lastAppliedSequence: number,
    limit = 500,
  ): Promise<ServiceResult<{ events: IncidentEvent[]; truncated: boolean }>> {
    const record = await this.store.find(incidentId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const events = await this.store.eventsAfter(incidentId, lastAppliedSequence, limit + 1);
    const truncated = events.length > limit;

    return { ok: true, value: { events: truncated ? [] : events, truncated } };
  }

  async queue(limit: number, cursor: string | null): Promise<{
    items: Array<{ id: string; claimedBy: string | null; version: number }>;
    nextCursor: string | null;
  }> {
    const page = await this.store.list(limit, cursor);
    const now = this.clock.now();

    return {
      items: page.items.map((record) => ({
        id: record.id,
        // A lapsed lease reads as unclaimed, so an operator picks up an incident nobody
        // is actually working rather than leaving it because a name is next to it.
        claimedBy: isHeld(record.claim, now) ? record.claim.holderId : null,
        version: record.claim.version,
      })),
      nextCursor: page.nextCursor,
    };
  }

  shouldRenewLease(record: IncidentRecord, operatorId: string): boolean {
    return shouldRenew(record.claim, operatorId, this.clock.now());
  }

  /** Re-exported so a client can share the exact reducer the server reasons about. */
  static readonly stream = { emptyStream, applyEvent, applyBatch, resumePoint, hasGap };
}

export type { StreamState };
