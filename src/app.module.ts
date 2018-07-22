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
import type { WorkOrderEvent } from './event-stream';
import {
  CLOCK,
  INCIDENT_STORE,
  WorkOrderService,
  type Clock,
  type WorkOrderRecord,
  type WorkOrderStore,
} from './work-order.service';

/**
 * The runnable service.
 *
 * Deliberately thin. Everything that decides anything is in `event-stream.ts`,
 * `claim.ts` and `workOrder.service.ts`; this file is transport. Keeping it thin is what
 * stops the concurrency logic drifting into a controller where it cannot be tested
 * without HTTP.
 */

// --- In-memory store ---------------------------------------------------------------

/**
 * The default adapter. The Postgres one implements the same contract with the version
 * check in the UPDATE and `(workOrder_id, sequence)` unique.
 *
 * Node runs a request handler on one thread, so the check-then-write below is atomic in
 * the same way a transaction makes the SQL version atomic. That is what makes the racing
 * tests meaningful rather than decorative.
 */
@Injectable()
export class MemoryWorkOrderStore implements WorkOrderStore {
  private readonly records = new Map<string, WorkOrderRecord>();
  private readonly events = new Map<string, WorkOrderEvent[]>();

  async find(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.records.get(workOrderId) ?? null;
  }

  async create(workOrderId: string): Promise<WorkOrderRecord> {
    const record: WorkOrderRecord = {
      id: workOrderId,
      claim: { workOrderId, holderId: null, claimedAt: null, expiresAt: null, version: 0 },
      events: [],
    };
    this.records.set(workOrderId, record);
    this.events.set(workOrderId, []);
    return record;
  }

  async saveClaim(workOrderId: string, next: ClaimState, expectedVersion: number): Promise<boolean> {
    const current = this.records.get(workOrderId);
    if (current === undefined) return false;
    // The equivalent of WHERE version = $n. A mismatch means somebody committed first.
    if (current.claim.version !== expectedVersion) return false;

    this.records.set(workOrderId, { ...current, claim: next });
    return true;
  }

  async appendEvent(
    workOrderId: string,
    event: Omit<WorkOrderEvent, 'sequence'>,
  ): Promise<WorkOrderEvent> {
    const existing = this.events.get(workOrderId) ?? [];
    // Allocated here, by the store, never by the caller. Two writers cannot both decide
    // they are number seven.
    const stored: WorkOrderEvent = { ...event, sequence: existing.length + 1 };
    this.events.set(workOrderId, [...existing, stored]);
    return stored;
  }

  async eventsAfter(workOrderId: string, sequence: number, limit: number): Promise<WorkOrderEvent[]> {
    return (this.events.get(workOrderId) ?? [])
      .filter((event) => event.sequence > sequence)
      .slice(0, limit);
  }

  async list(limit: number, cursor: string | null): Promise<{ items: WorkOrderRecord[]; nextCursor: string | null }> {
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

const claimSchema = z.object({ engineerId: z.string().min(1), expectedVersion: z.number().int().min(0) });
const noteSchema = claimSchema.extend({ note: z.string().trim().min(1).max(2000) });

function statusFor(error: ClaimError | { kind: 'not_found' }): number {
  switch (error.kind) {
    case 'not_found':
      return HttpStatus.NOT_FOUND;
    case 'held_by_other':
    case 'stale_version':
      // Conflict rather than 412: the client sent a version in the body and lost a race.
      // The response carries what it needs to reload and show the engineer what changed.
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

@Controller('api/workOrders')
export class WorkOrderController {
  constructor(
    private readonly workOrders: WorkOrderService,
    @Inject(INCIDENT_STORE) private readonly store: WorkOrderStore,
  ) {}

  @Get()
  async queue(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.workOrders.queue(Math.min(Number(limit ?? 25) || 25, 100), cursor ?? null);
  }

  /** A synthetic device raising an workOrder. There is no real device in this repository. */
  @Post(':id')
  async create(@Param('id') id: string) {
    const existing = await this.store.find(id);
    return existing ?? (await this.store.create(id));
  }

  @Post(':id/claim')
  async claim(@Param('id') id: string, @Body() body: unknown) {
    const parsed = claimSchema.parse(body);
    const result = await this.workOrders.claimWorkOrder(id, parsed.engineerId, parsed.expectedVersion);
    if (!result.ok) throw new HttpException({ error: result.error }, statusFor(result.error));
    return result.value;
  }

  @Post(':id/release')
  async release(@Param('id') id: string, @Body() body: unknown) {
    const parsed = claimSchema.parse(body);
    const result = await this.workOrders.releaseWorkOrder(id, parsed.engineerId, parsed.expectedVersion);
    if (!result.ok) throw new HttpException({ error: result.error }, statusFor(result.error));
    return result.value;
  }

  @Post(':id/notes')
  async addNote(@Param('id') id: string, @Body() body: unknown) {
    const parsed = noteSchema.parse(body);
    const result = await this.workOrders.addNote(id, parsed.engineerId, parsed.note, parsed.expectedVersion);
    if (!result.ok) throw new HttpException({ error: result.error }, statusFor(result.error));
    return result.value;
  }

  @Get(':id/resume')
  async resume(@Param('id') id: string, @Query('after') after?: string) {
    const result = await this.workOrders.resume(id, Number(after ?? 0) || 0);
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
export class WorkOrderGateway implements OnGatewayConnection {
  @WebSocketServer() private server!: Server;

  constructor(private readonly workOrders: WorkOrderService) {}

  handleConnection(socket: Socket): void {
    void socket;
  }

  @SubscribeMessage('workOrder.subscribe')
  async subscribe(socket: Socket, payload: { workOrderId: string }): Promise<void> {
    await socket.join(`workOrder:${payload.workOrderId}`);
  }

  @SubscribeMessage('workOrder.resume')
  async resume(socket: Socket, payload: { workOrderId: string; lastSequence: number }): Promise<void> {
    const result = await this.workOrders.resume(payload.workOrderId, payload.lastSequence);
    if (!result.ok) return;

    await socket.join(`workOrder:${payload.workOrderId}`);
    socket.emit('workOrder.resumed', {
      workOrderId: payload.workOrderId,
      events: result.value.events,
      truncated: result.value.truncated,
    });
  }

  broadcast(workOrderId: string, event: WorkOrderEvent): void {
    this.server?.to(`workOrder:${workOrderId}`).emit('workOrder.event', event);
  }
}

// --- Module ---------------------------------------------------------------------------


@Module({
  controllers: [WorkOrderController, HealthController],
  providers: [
    WorkOrderService,
    WorkOrderGateway,
    { provide: INCIDENT_STORE, useClass: MemoryWorkOrderStore },
    { provide: CLOCK, useClass: SystemClock },
  ],
})
export class AppModule {}
