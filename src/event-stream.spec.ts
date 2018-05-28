

import {
  MAX_BUFFER_AHEAD,
  applyBatch,
  applyEvent,
  emptyStream,
  hasGap,
  missingSequences,
  resumePoint,
  type IncidentEvent,
} from './event-stream';

function event(sequence: number, type = 'incident.location_recorded'): IncidentEvent {
  return {
    incidentId: 'incident-1',
    sequence,
    type,
    occurredAt: '2026-03-14T19:45:00.000Z',
    payload: {},
  };
}

describe('in-order delivery', () => {
  it('applies a contiguous stream', () => {
    let state = emptyStream;
    for (const sequence of [1, 2, 3, 4]) state = applyEvent(state, event(sequence)).state;

    expect(state.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(state.appliedThrough).toBe(4);
    expect(state.buffered).toHaveLength(0);
  });
});

describe('out-of-order delivery', () => {
  it('buffers an event that arrives early rather than rendering it in the wrong place', () => {
    let state = applyEvent(emptyStream, event(1)).state;
    state = applyEvent(state, event(3)).state;

    // Applying 3 while 2 is missing would put an operator note above the action it
    // describes.
    expect(state.applied.map((e) => e.sequence)).toEqual([1]);
    expect(state.buffered.map((e) => e.sequence)).toEqual([3]);
    expect(hasGap(state)).toBe(true);
  });

  it('drains the buffer as soon as the gap fills', () => {
    let state = applyEvent(emptyStream, event(1)).state;
    state = applyEvent(state, event(4)).state;
    state = applyEvent(state, event(3)).state;
    state = applyEvent(state, event(2)).state;

    expect(state.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(state.buffered).toHaveLength(0);
    expect(hasGap(state)).toBe(false);
  });

  it('handles a whole stream delivered backwards', () => {
    let state = emptyStream;
    for (const sequence of [5, 4, 3, 2, 1]) state = applyEvent(state, event(sequence)).state;

    expect(state.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reports which sequences are missing, for the banner', () => {
    let state = applyEvent(emptyStream, event(1)).state;
    state = applyEvent(state, event(5)).state;
    state = applyEvent(state, event(3)).state;

    expect(missingSequences(state)).toEqual([2, 4]);
  });
});

describe('duplicates', () => {
  it('drops a replay of something already applied', () => {
    let state = applyEvent(emptyStream, event(1)).state;
    state = applyEvent(state, event(2)).state;

    // Exactly what a reconnect produces, where the replay overlaps with what arrived
    // before the drop.
    state = applyEvent(state, event(1)).state;
    state = applyEvent(state, event(2)).state;

    expect(state.applied).toHaveLength(2);
    expect(state.droppedDuplicates).toBe(2);
  });

  it('drops a duplicate of something still in the buffer', () => {
    let state = applyEvent(emptyStream, event(1)).state;
    state = applyEvent(state, event(3)).state;
    state = applyEvent(state, event(3)).state;

    expect(state.buffered).toHaveLength(1);
    expect(state.droppedDuplicates).toBe(1);
  });

  it('never applies the same sequence twice, however it arrives', () => {
    let state = emptyStream;
    const arrivals = [1, 3, 2, 3, 1, 4, 2, 5, 5, 4];
    for (const sequence of arrivals) state = applyEvent(state, event(sequence)).state;

    expect(state.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('reconnection', () => {
  it('resumes from the highest applied sequence, not the highest received', () => {
    let state = applyEvent(emptyStream, event(1)).state;
    state = applyEvent(state, event(2)).state;
    state = applyEvent(state, event(9)).state; // buffered, not applied

    // Asking to resume from 9 would skip 3 through 8 for ever.
    expect(resumePoint(state)).toBe(2);
  });

  it('resumes from zero when nothing has been applied, meaning send everything', () => {
    expect(resumePoint(emptyStream)).toBe(0);
  });

  it('applies a replayed batch and drains the buffer it was waiting on', () => {
    let state = applyEvent(emptyStream, event(1)).state;
    state = applyEvent(state, event(6)).state;

    // The socket dropped after 1 and came back with 6 already received. The resume
    // response fills 2 through 5.
    const outcome = applyBatch(state, [event(2), event(3), event(4), event(5)]);

    expect(outcome.state.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(outcome.state.buffered).toHaveLength(0);
    expect(outcome.needsRefetch).toBe(false);
  });

  it('sorts a batch before applying, so a reversed replay still drains in one pass', () => {
    const outcome = applyBatch(emptyStream, [event(3), event(1), event(2)]);
    expect(outcome.state.applied.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(outcome.state.buffered).toHaveLength(0);
  });

  it('loses nothing across a drop and a resume', () => {
    let state = emptyStream;
    for (const sequence of [1, 2, 3]) state = applyEvent(state, event(sequence)).state;

    // Connection drops. 4 through 8 happen while the client is away.
    const missed = [4, 5, 6, 7, 8].map((sequence) => event(sequence));
    const resumed = applyBatch(state, missed);

    // Then the live stream resumes, overlapping with the replay.
    const live = applyEvent(resumed.state, event(8));

    expect(live.state.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(live.state.droppedDuplicates).toBe(1);
  });
});

describe('unbounded buffering', () => {
  it('asks for a refetch when the gap grows past the replay window', () => {
    const state = applyEvent(emptyStream, event(1)).state;
    const outcome = applyEvent(state, event(MAX_BUFFER_AHEAD + 50));

    // Without this bound, a client that missed a thousand events accumulates a thousand
    // buffered items that can never drain, and the tab eventually dies.
    expect(outcome.needsRefetch).toBe(true);
  });

  it('does not ask for a refetch for a small gap', () => {
    const state = applyEvent(emptyStream, event(1)).state;
    expect(applyEvent(state, event(5)).needsRefetch).toBe(false);
  });
});

describe('immutability', () => {
  it('does not mutate the state it was given', () => {
    const state = applyEvent(emptyStream, event(1)).state;
    const before = state.applied.length;

    applyEvent(state, event(2));

    expect(state.applied.length).toBe(before);
    expect(emptyStream.applied).toHaveLength(0);
  });
});
