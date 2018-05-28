import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule, MemoryIncidentStore } from '../src/app.module';
import { CLOCK, INCIDENT_STORE } from '../src/incident.service';
import { LEASE_MS } from '../src/claim';

/**
 * The concurrency rules, over real HTTP, against the running service.
 *
 * The unit tests prove the decisions are correct. These prove the decisions are actually
 * wired to the transport, which is a different claim and the one that has historically
 * been wrong: a rule that is right in a pure function and never called from the controller
 * protects nothing.
 *
 * Still no database and no Redis. The in-memory store enforces the same version check.
 */

class ControllableClock {
  constructor(private current = 1_773_000_000_000) {}
  now(): number { return this.current; }
  advance(ms: number): void { this.current += ms; }
}

let app: INestApplication;
let http: App;
let clock: ControllableClock;

beforeEach(async () => {
  clock = new ControllableClock();

  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(INCIDENT_STORE)
    .useValue(new MemoryIncidentStore())
    .compile();

  app = module.createNestApplication();
  await app.init();
  http = app.getHttpServer();
});

afterEach(async () => {
  await app.close();
});

async function anIncident(id = 'incident-1') {
  await request(http).post(`/api/incidents/${id}`).expect(201);
  return id;
}

describe('the service runs', () => {
  it('answers a health check', async () => {
    const response = await request(http).get('/health').expect(200);
    expect(response.body.status).toBe('ok');
  });

  it('serves an empty queue', async () => {
    const response = await request(http).get('/api/incidents').expect(200);
    expect(response.body.items).toEqual([]);
  });
});

describe('claiming over HTTP', () => {
  it('lets an operator claim an unheld incident', async () => {
    const id = await anIncident();

    const response = await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    expect(response.body.holderId).toBe('alice');
    expect(response.body.version).toBe(1);
  });

  it('returns 409 to the second operator, naming the holder', async () => {
    const id = await anIncident();

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    const conflict = await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'bob', expectedVersion: 1 })
      .expect(409);

    // Naming the holder saves the losing operator a trip to Slack to find out who.
    expect(conflict.body.error.kind).toBe('held_by_other');
    expect(conflict.body.error.holderId).toBe('alice');
  });

  it('returns 409 for a stale version even when the incident is unclaimed', async () => {
    const id = await anIncident();

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    // Bob's console still shows version 0.
    const conflict = await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'bob', expectedVersion: 0 })
      .expect(409);

    expect(conflict.body.error.kind).toBe('stale_version');
  });

  it('lets another operator take over once the lease lapses', async () => {
    const id = await anIncident();

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    clock.advance(LEASE_MS + 1);

    const response = await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'bob', expectedVersion: 1 })
      .expect(201);

    expect(response.body.holderId).toBe('bob');
  });

  it('shows a lapsed claim as unclaimed in the queue', async () => {
    const id = await anIncident();

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    clock.advance(LEASE_MS + 1);

    const queue = await request(http).get('/api/incidents').expect(200);
    // Otherwise an operator leaves it alone because a name is next to it, and nobody
    // works an incident that nobody is working.
    expect(queue.body.items[0].claimedBy).toBeNull();
  });
});

describe('mutations are guarded by both checks', () => {
  it('refuses a note from an operator who has not claimed it', async () => {
    const id = await anIncident();

    const response = await request(http)
      .post(`/api/incidents/${id}/notes`)
      .send({ operatorId: 'alice', note: 'trying anyway', expectedVersion: 0 })
      .expect(403);

    expect(response.body.error.kind).toBe('not_holder');
  });

  it('refuses a note from an operator whose claim was taken over', async () => {
    const id = await anIncident();

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    clock.advance(LEASE_MS + 1);

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'bob', expectedVersion: 1 })
      .expect(201);

    // Alice is up to date and no longer entitled. The lease catches this one, not the
    // version.
    const response = await request(http)
      .post(`/api/incidents/${id}/notes`)
      .send({ operatorId: 'alice', note: 'still here', expectedVersion: 2 })
      .expect(409);

    expect(response.body.error.kind).toBe('held_by_other');
  });

  it('refuses a note from the holder acting on a stale view', async () => {
    const id = await anIncident();

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    // Alice holds the claim, and her tab is showing the incident as she loaded it.
    const response = await request(http)
      .post(`/api/incidents/${id}/notes`)
      .send({ operatorId: 'alice', note: 'from a stale tab', expectedVersion: 0 })
      .expect(409);

    expect(response.body.error.kind).toBe('stale_version');
  });

  it('accepts a note from the holder with a current version', async () => {
    const id = await anIncident();

    const claimed = await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    const response = await request(http)
      .post(`/api/incidents/${id}/notes`)
      .send({ operatorId: 'alice', note: 'called the subject', expectedVersion: claimed.body.version })
      .expect(201);

    expect(response.body.type).toBe('incident.operator_note_added');
    expect(response.body.sequence).toBeGreaterThan(0);
  });
});

describe('resume over HTTP', () => {
  it('returns only the events after the sequence the client has applied', async () => {
    const id = await anIncident();

    await request(http)
      .post(`/api/incidents/${id}/claim`)
      .send({ operatorId: 'alice', expectedVersion: 0 })
      .expect(201);

    for (const note of ['one', 'two', 'three']) {
      const current = await request(http).get(`/api/incidents/${id}/resume?after=0`).expect(200);
      const version = 1;
      await request(http)
        .post(`/api/incidents/${id}/notes`)
        .send({ operatorId: 'alice', note, expectedVersion: version })
        .expect(201);
      void current;
    }

    const all = await request(http).get(`/api/incidents/${id}/resume?after=0`).expect(200);
    expect(all.body.events.length).toBe(4); // claim + three notes

    const delta = await request(http).get(`/api/incidents/${id}/resume?after=2`).expect(200);
    expect(delta.body.events.map((event: { sequence: number }) => event.sequence)).toEqual([3, 4]);
  });

  it('returns 404 for an incident that does not exist', async () => {
    await request(http).get('/api/incidents/nope/resume?after=0').expect(404);
  });
});

describe('two operators racing over HTTP', () => {
  it('gives the incident to exactly one of them', async () => {
    const id = await anIncident();

    // Both consoles loaded version 0 and both pressed claim.
    const [alice, bob] = await Promise.all([
      request(http).post(`/api/incidents/${id}/claim`).send({ operatorId: 'alice', expectedVersion: 0 }),
      request(http).post(`/api/incidents/${id}/claim`).send({ operatorId: 'bob', expectedVersion: 0 }),
    ]);

    const statuses = [alice.status, bob.status].sort();
    expect(statuses).toEqual([201, 409]);

    const queue = await request(http).get('/api/incidents').expect(200);
    expect(queue.body.items[0].claimedBy).toMatch(/alice|bob/);
    expect(queue.body.items[0].version).toBe(1);
  });
});
