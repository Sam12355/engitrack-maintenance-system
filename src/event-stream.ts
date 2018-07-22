/**
 * The client-side event stream.
 *
 * This is the piece that decides what an engineer actually sees. Events arrive over a
 * socket that drops, on a network that reorders, sometimes twice, and sometimes with a
 * gap in the middle. Everything below is about making that produce a correct, ordered,
 * gap-free view without the engineer ever needing to press refresh.
 *
 * The rules, in order of how much they matter:
 *
 *   1. Order by sequence, never by timestamp. Device and server clocks disagree.
 *   2. Drop anything at or below the highest sequence already applied. That makes
 *      duplicate delivery, which is normal after a reconnect, completely harmless.
 *   3. Hold an out-of-order arrival in a buffer rather than applying it. Applying
 *      sequence 9 while 8 is missing renders a note above the action it describes.
 *   4. On reconnect, ask for everything after the highest applied sequence. Beyond a
 *      replay window, refetch instead: streaming ten thousand events to catch up is
 *      slower than one read.
 */

export interface WorkOrderEvent {
  readonly workOrderId: string;
  /** Per-workOrder, monotonic, allocated by the server inside the writing transaction. */
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StreamState {
  /** Events applied, always contiguous and always in sequence order. */
  readonly applied: readonly WorkOrderEvent[];
  /** Arrived early, waiting for the gap in front of them to fill. */
  readonly buffered: readonly WorkOrderEvent[];
  readonly appliedThrough: number;
  readonly droppedDuplicates: number;
}

export const emptyStream: StreamState = {
  applied: [],
  buffered: [],
  appliedThrough: 0,
  droppedDuplicates: 0,
};

/**
 * How far ahead of the applied position an event may be before we stop buffering it.
 *
 * Without a bound, a client that missed a thousand events accumulates a thousand buffered
 * items that can never drain, and the memory grows until the tab dies. Past this, the
 * stream reports a gap and the caller refetches.
 */
export const MAX_BUFFER_AHEAD = 100;

export interface ApplyOutcome {
  readonly state: StreamState;
  /** True when the buffer suggests the client has missed events it will not receive. */
  readonly needsRefetch: boolean;
}

export function applyEvent(state: StreamState, incoming: WorkOrderEvent): ApplyOutcome {
  // Already seen. This is the common case after a reconnect, where the replay overlaps
  // with what was received before the drop.
  if (incoming.sequence <= state.appliedThrough) {
    return {
      state: { ...state, droppedDuplicates: state.droppedDuplicates + 1 },
      needsRefetch: false,
    };
  }

  if (state.buffered.some((event) => event.sequence === incoming.sequence)) {
    return {
      state: { ...state, droppedDuplicates: state.droppedDuplicates + 1 },
      needsRefetch: false,
    };
  }

  // Not the next one. Hold it and wait for the gap to fill rather than rendering it out
  // of order.
  if (incoming.sequence !== state.appliedThrough + 1) {
    const buffered = [...state.buffered, incoming].sort((a, b) => a.sequence - b.sequence);
    const furthestAhead = (buffered.at(-1)?.sequence ?? 0) - state.appliedThrough;

    return {
      state: { ...state, buffered },
      needsRefetch: furthestAhead > MAX_BUFFER_AHEAD,
    };
  }

  // It is the next one. Apply it, then drain whatever the buffer now makes contiguous.
  let appliedThrough = incoming.sequence;
  const applied = [...state.applied, incoming];
  const remaining = [...state.buffered].sort((a, b) => a.sequence - b.sequence);

  while (remaining.length > 0 && remaining[0]?.sequence === appliedThrough + 1) {
    const next = remaining.shift();
    if (next === undefined) break;
    applied.push(next);
    appliedThrough = next.sequence;
  }

  return {
    state: { ...state, applied, buffered: remaining, appliedThrough },
    needsRefetch: false,
  };
}

/** Applies a batch, which is what a resume response delivers. */
export function applyBatch(state: StreamState, events: readonly WorkOrderEvent[]): ApplyOutcome {
  let current = state;
  let needsRefetch = false;

  // Sorted first so a batch delivered in reverse does not spend the whole batch in the
  // buffer before draining in one go at the end.
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const outcome = applyEvent(current, event);
    current = outcome.state;
    needsRefetch = needsRefetch || outcome.needsRefetch;
  }

  return { state: current, needsRefetch };
}

/** What to send on reconnect. Zero means the client has nothing and wants everything. */
export function resumePoint(state: StreamState): number {
  return state.appliedThrough;
}

/**
 * Sequences the client is missing.
 *
 * Only useful for diagnostics and for the "some events are missing" banner. Recovery is
 * driven by the resume request, not by asking for individual gaps, because a per-gap
 * fetch turns one round trip into many on exactly the connection that was already
 * struggling.
 */
export function missingSequences(state: StreamState): number[] {
  if (state.buffered.length === 0) return [];

  const highestBuffered = state.buffered.at(-1)?.sequence ?? state.appliedThrough;
  const present = new Set(state.buffered.map((event) => event.sequence));
  const missing: number[] = [];

  for (let sequence = state.appliedThrough + 1; sequence < highestBuffered; sequence += 1) {
    if (!present.has(sequence)) missing.push(sequence);
  }

  return missing;
}

export function hasGap(state: StreamState): boolean {
  return state.buffered.length > 0;
}
