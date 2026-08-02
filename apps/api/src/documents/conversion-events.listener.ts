import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobResult } from '@drm/shared';
import { PrismaService } from '../prisma/prisma.service';

// Listens for `document-conversion` job completion/failure via BullMQ's
// QueueEvents (the same class Phase 4A's jobs.e2e-spec.ts already proved
// works against this project's real Redis, rather than @nestjs/bullmq's
// @OnWorkerEvent decorator sugar, which is for a Worker/consumer process --
// this listener runs inside apps/api, the producer side).
//
// Single responsibility: react to job outcomes and update the one field
// this listener owns, DocumentVersion.previewObjectKey. It does not enqueue
// jobs (that's DocumentsService.maybeEnqueueConversion) and does not know
// anything about the upload flow.
//
// Real BullMQ behavior (verified by reading bullmq@5.81.3's
// classes/queue-events.js consumeEvents()): the `completed` case already
// does `args.returnvalue = JSON.parse(args.returnvalue)` internally before
// emitting the event, so by the time this listener's `completed` handler
// runs, `returnvalue` is always already a parsed object, never a raw JSON
// string. The brief's draft speculated it might arrive as either; in
// practice the string branch of the typeof check below is dead code at
// this BullMQ version, but it's kept as cheap defensive insurance in case
// that internal parsing behavior ever changes across a BullMQ upgrade.
@Injectable()
export class ConversionEventsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversionEventsListener.name);
  private queueEvents!: QueueEvents;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.queueEvents = new QueueEvents(QUEUE_DOCUMENT_CONVERSION, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });

    this.queueEvents.on('completed', ({ returnvalue }) => {
      void this.handleCompleted(returnvalue);
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.error(`Conversion job ${jobId} failed: ${failedReason}`);
    });
  }

  private async handleCompleted(returnvalue: unknown) {
    const result = (
      typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue
    ) as ConversionJobResult;

    try {
      await this.prisma.documentVersion.update({
        where: { id: result.documentVersionId },
        data: { previewObjectKey: result.previewObjectKey },
      });
    } catch (error) {
      // The conversion succeeded but recording the result failed (e.g. the
      // DocumentVersion row was deleted in the meantime). Log and move on --
      // there is no upload request left waiting on this async completion,
      // so there is nothing to fail back to.
      this.logger.error(
        `Failed to record previewObjectKey for document version ${result.documentVersionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onModuleDestroy() {
    await this.queueEvents.close();
  }
}
