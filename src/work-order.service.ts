import { Inject, Injectable } from '@nestjs/common';

import {
  applyBatch,
  applyEvent,
  emptyStream,
  hasGap,
  resumePoint,
  type WorkOrderEvent,
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
 * is what lets "two engineers race for the same workOrder" stay a unit test rather than
 * something reproduced with two browser windows and good timing.
 */

export const INCIDENT_STORE = Symbol('WorkOrderStore');
export const CLOCK = Symbol('Clock');

export interface WorkOrderRecord {
  readonly id: string;
  readonly claim: ClaimState;
  readonly events: readonly WorkOrderEvent[];
}

/**
 * Persistence port. The in-memory adapter is the default and is what the tests use; the
 * Postgres adapter implements the same contract with a version check in the UPDATE.
 */
export interface WorkOrderStore {
  find(workOrderId: string): Promise<WorkOrderRecord | null>;
  create(workOrderId: string): Promise<WorkOrderRecord>;
  saveClaim(workOrderId: string, next: ClaimState, expectedVersion: number): Promise<boolean>;
  appendEvent(workOrderId: string, event: Omit<WorkOrderEvent, 'sequence'>): Promise<WorkOrderEvent>;
  eventsAfter(workOrderId: string, sequence: number, limit: number): Promise<WorkOrderEvent[]>;
  list(limit: number, cursor: string | null): Promise<{ items: WorkOrderRecord[]; nextCursor: string | null }>;
}

export interface Clock {
  now(): number;
}

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ClaimError | { kind: 'not_found' } };

@Injectable()
export class WorkOrderService {
  constructor(
    @Inject(INCIDENT_STORE) private readonly store: WorkOrderStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async claimWorkOrder(
    workOrderId: string,
    engineerId: string,
    expectedVersion: number,
  ): Promise<ServiceResult<ClaimState>> {
    const record = await this.store.find(workOrderId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const decision = claim(record.claim, engineerId, expectedVersion, this.clock.now());
    if (!decision.ok) return decision;

    // The store performs the version check again in its UPDATE. Deciding and enforcing are
    // separate on purpose: the decision is testable without a database, and the database
    // is what makes it atomic against a concurrent writer.
    const saved = await this.store.saveClaim(workOrderId, decision.state, expectedVersion);
    if (!saved) {
      const current = await this.store.find(workOrderId);
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
      await this.store.appendEvent(workOrderId, {
        workOrderId,
        type: 'workOrder.engineer_claimed',
        occurredAt: new Date(this.clock.now()).toISOString(),
        payload: { engineerId },
      });
    }

    return { ok: true, value: decision.state };
  }

  async releaseWorkOrder(
    workOrderId: string,
    engineerId: string,
    expectedVersion: number,
  ): Promise<ServiceResult<ClaimState>> {
    const record = await this.store.find(workOrderId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const decision = release(record.claim, engineerId, expectedVersion, this.clock.now());
    if (!decision.ok) return decision;

    await this.store.saveClaim(workOrderId, decision.state, expectedVersion);
    await this.store.appendEvent(workOrderId, {
      workOrderId,
      type: 'workOrder.engineer_released',
      occurredAt: new Date(this.clock.now()).toISOString(),
      payload: { engineerId },
    });

    return { ok: true, value: decision.state };
  }

  /**
   * A note, or any other engineer mutation.
   *
   * Guarded by both the version and the lease. They catch different failures: an engineer
   * can hold the claim and still be looking at a stale workOrder, and another can be up to
   * date and have had the claim taken from them.
   */
  async addNote(
    workOrderId: string,
    engineerId: string,
    note: string,
    expectedVersion: number,
  ): Promise<ServiceResult<WorkOrderEvent>> {
    const record = await this.store.find(workOrderId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const allowed = authoriseMutation(record.claim, engineerId, expectedVersion, this.clock.now());
    if (!allowed.ok) return allowed;

    const event = await this.store.appendEvent(workOrderId, {
      workOrderId,
      type: 'workOrder.engineer_note_added',
      occurredAt: new Date(this.clock.now()).toISOString(),
      payload: { engineerId, note },
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
    workOrderId: string,
    lastAppliedSequence: number,
    limit = 500,
  ): Promise<ServiceResult<{ events: WorkOrderEvent[]; truncated: boolean }>> {
    const record = await this.store.find(workOrderId);
    if (record === null) return { ok: false, error: { kind: 'not_found' } };

    const events = await this.store.eventsAfter(workOrderId, lastAppliedSequence, limit + 1);
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
        // A lapsed lease reads as unclaimed, so an engineer picks up an workOrder nobody
        // is actually working rather than leaving it because a name is next to it.
        claimedBy: isHeld(record.claim, now) ? record.claim.holderId : null,
        version: record.claim.version,
      })),
      nextCursor: page.nextCursor,
    };
  }

  shouldRenewLease(record: WorkOrderRecord, engineerId: string): boolean {
    return shouldRenew(record.claim, engineerId, this.clock.now());
  }

  /** Re-exported so a client can share the exact reducer the server reasons about. */
  static readonly stream = { emptyStream, applyEvent, applyBatch, resumePoint, hasGap };
}

export type { StreamState };
