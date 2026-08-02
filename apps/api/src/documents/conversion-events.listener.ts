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
      // handleCompleted must never produce an unhandled promise rejection
      // here: this listener's constructor doesn't attach any other
      // rejection handler, and under Node 20's default
      // --unhandled-rejections=throw, an unhandled rejection crashes the
      // *entire* api process on a single malformed conversion event --
      // taking down every user's request, not just this one job. Catch
      // defensively at the call site in addition to handleCompleted's own
      // internal try/catch.
      this.handleCompleted(returnvalue).catch((error: unknown) => {
        this.logger.error(
          `Failed to process conversion completion: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.error(`Conversion job ${jobId} failed: ${failedReason}`);
    });
  }

  private async handleCompleted(returnvalue: unknown) {
    try {
      // The parse/cast is inside the try (not just the Prisma call below)
      // so a malformed or unparseable `returnvalue` is caught here too,
      // instead of throwing synchronously out of this async function
      // before the try block was even reached.
      const result = (
        typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue
      ) as ConversionJobResult;

      if (!result || typeof result !== 'object' || !result.documentVersionId || !result.previewObjectKey) {
        this.logger.error(
          `Malformed conversion job completion event, ignoring: ${JSON.stringify(returnvalue)}`,
        );
        return;
      }

      await this.prisma.documentVersion.update({
        where: { id: result.documentVersionId },
        data: { previewObjectKey: result.previewObjectKey },
      });
    } catch (error) {
      // Covers both a bad `returnvalue` (parse/shape failure above) and the
      // conversion having succeeded but recording the result failing (e.g.
      // the DocumentVersion row was deleted in the meantime). Log and move
      // on -- there is no upload request left waiting on this async
      // completion, so there is nothing to fail back to.
      this.logger.error(
        `Failed to process conversion completion: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onModuleDestroy() {
    await this.queueEvents.close();
  }
}
