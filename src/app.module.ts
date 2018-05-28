import {
  Body,
  Controller,
  Get,
  Inject,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';

import type { ClaimError, ClaimState } from './claim';
import type { IncidentEvent } from './event-stream';
import {
  CLOCK,
  INCIDENT_STORE,
  IncidentService,
  type Clock,
  type IncidentRecord,
  type IncidentStore,
} from './incident.service';

/**
 * The runnable service.
 *
 * Deliberately thin. Everything that decides anything is in `event-stream.ts`,
 * `claim.ts` and `incident.service.ts`; this file is transport. Keeping it thin is what
 * stops the concurrency logic drifting into a controller where it cannot be tested
 * without HTTP.
 */

// --- In-memory store ---------------------------------------------------------------

/**
 * The default adapter. The Postgres one implements the same contract with the version
 * check in the UPDATE and `(incident_id, sequence)` unique.
 *
 * Node runs a request handler on one thread, so the check-then-write below is atomic in
 * the same way a transaction makes the SQL version atomic. That is what makes the racing
 * tests meaningful rather than decorative.
 */
@Injectable()
export class MemoryIncidentStore implements IncidentStore {
  private readonly records = new Map<string, IncidentRecord>();
  private readonly events = new Map<string, IncidentEvent[]>();

  async find(incidentId: string): Promise<IncidentRecord | null> {
    return this.records.get(incidentId) ?? null;
  }

  async create(incidentId: string): Promise<IncidentRecord> {
    const record: IncidentRecord = {
      id: incidentId,
      claim: { incidentId, holderId: null, claimedAt: null, expiresAt: null, version: 0 },
      events: [],
    };
    this.records.set(incidentId, record);
    this.events.set(incidentId, []);
    return record;
  }

  async saveClaim(incidentId: string, next: ClaimState, expectedVersion: number): Promise<boolean> {
    const current = this.records.get(incidentId);
    if (current === undefined) return false;
    // The equivalent of WHERE version = $n. A mismatch means somebody committed first.
    if (current.claim.version !== expectedVersion) return false;

    this.records.set(incidentId, { ...current, claim: next });
    return true;
  }

  async appendEvent(
    incidentId: string,
    event: Omit<IncidentEvent, 'sequence'>,
  ): Promise<IncidentEvent> {
    const existing = this.events.get(incidentId) ?? [];
    // Allocated here, by the store, never by the caller. Two writers cannot both decide
    // they are number seven.
    const stored: IncidentEvent = { ...event, sequence: existing.length + 1 };
    this.events.set(incidentId, [...existing, stored]);
    return stored;
  }

  async eventsAfter(incidentId: string, sequence: number, limit: number): Promise<IncidentEvent[]> {
    return (this.events.get(incidentId) ?? [])
      .filter((event) => event.sequence > sequence)
      .slice(0, limit);
  }

  async list(limit: number, cursor: string | null): Promise<{ items: IncidentRecord[]; nextCursor: string | null }> {
    const all = [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
    const start = cursor === null ? 0 : all.findIndex((record) => record.id === cursor) + 1;
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;

    return { items: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }
}

@Injectable()
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

// --- HTTP ---------------------------------------------------------------------------

const claimSchema = z.object({ operatorId: z.string().min(1), expectedVersion: z.number().int().min(0) });
const noteSchema = claimSchema.extend({ note: z.string().trim().min(1).max(2000) });

function statusFor(error: ClaimError | { kind: 'not_found' }): number {
  switch (error.kind) {
    case 'not_found':
      return HttpStatus.NOT_FOUND;
    case 'held_by_other':
    case 'stale_version':
      // Conflict rather than 412: the client sent a version in the body and lost a race.
      // The response carries what it needs to reload and show the operator what changed.
      return HttpStatus.CONFLICT;
    case 'not_holder':
      return HttpStatus.FORBIDDEN;
    default: {
      const exhaustive: never = error;
      void exhaustive;
      return HttpStatus.INTERNAL_SERVER_ERROR;
    }
  }
}

@Controller('api/incidents')
export class IncidentController {
  constructor(
    private readonly incidents: IncidentService,
    @Inject(INCIDENT_STORE) private readonly store: IncidentStore,
  ) {}

  @Get()
  async queue(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.incidents.queue(Math.min(Number(limit ?? 25) || 25, 100), cursor ?? null);
  }

  /** A synthetic device raising an incident. There is no real device in this repository. */
  @Post(':id')
  async create(@Param('id') id: string) {
    const existing = await this.store.find(id);
    return existing ?? (await this.store.create(id));
  }

  @Post(':id/claim')
  async claim(@Param('id') id: string, @Body() body: unknown) {
    const parsed = claimSchema.parse(body);
    const result = await this.incidents.claimIncident(id, parsed.operatorId, parsed.expectedVersion);
    if (!result.ok) throw new HttpException({ error: result.error }, statusFor(result.error));
    return result.value;
  }

  @Post(':id/release')
  async release(@Param('id') id: string, @Body() body: unknown) {
    const parsed = claimSchema.parse(body);
    const result = await this.incidents.releaseIncident(id, parsed.operatorId, parsed.expectedVersion);
    if (!result.ok) throw new HttpException({ error: result.error }, statusFor(result.error));
    return result.value;
  }

  @Post(':id/notes')
  async addNote(@Param('id') id: string, @Body() body: unknown) {
    const parsed = noteSchema.parse(body);
    const result = await this.incidents.addNote(id, parsed.operatorId, parsed.note, parsed.expectedVersion);
    if (!result.ok) throw new HttpException({ error: result.error }, statusFor(result.error));
    return result.value;
  }

  @Get(':id/resume')
  async resume(@Param('id') id: string, @Query('after') after?: string) {
    const result = await this.incidents.resume(id, Number(after ?? 0) || 0);
    if (!result.ok) throw new HttpException({ error: result.error }, statusFor(result.error));
    return result.value;
  }
}

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

// --- Socket ---------------------------------------------------------------------------

/**
 * Real-time updates.
 *
 * The resume handler is the interesting one: the client sends the highest sequence it has
 * applied, and gets exactly the gap. Nothing is lost because the socket dropped, and
 * nothing needs a full refetch unless the gap exceeds the window.
 */
@WebSocketGateway({ cors: { origin: true } })
export class IncidentGateway implements OnGatewayConnection {
  @WebSocketServer() private server!: Server;

  constructor(private readonly incidents: IncidentService) {}

  handleConnection(socket: Socket): void {
    void socket;
  }

  @SubscribeMessage('incident.subscribe')
  async subscribe(socket: Socket, payload: { incidentId: string }): Promise<void> {
    await socket.join(`incident:${payload.incidentId}`);
  }

  @SubscribeMessage('incident.resume')
  async resume(socket: Socket, payload: { incidentId: string; lastSequence: number }): Promise<void> {
    const result = await this.incidents.resume(payload.incidentId, payload.lastSequence);
    if (!result.ok) return;

    await socket.join(`incident:${payload.incidentId}`);
    socket.emit('incident.resumed', {
      incidentId: payload.incidentId,
      events: result.value.events,
      truncated: result.value.truncated,
    });
  }

  broadcast(incidentId: string, event: IncidentEvent): void {
    this.server?.to(`incident:${incidentId}`).emit('incident.event', event);
  }
}

// --- Module ---------------------------------------------------------------------------


@Module({
  controllers: [IncidentController, HealthController],
  providers: [
    IncidentService,
    IncidentGateway,
    { provide: INCIDENT_STORE, useClass: MemoryIncidentStore },
    { provide: CLOCK, useClass: SystemClock },
  ],
})
export class AppModule {}
