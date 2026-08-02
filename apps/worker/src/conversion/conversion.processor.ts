import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobData, ConversionJobResult } from '@drm/shared';
import { randomUUID } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { StorageService } from '../storage/storage.service';

@Processor(QUEUE_DOCUMENT_CONVERSION)
export class ConversionProcessor extends WorkerHost {
  private readonly logger = new Logger(ConversionProcessor.name);

  constructor(private readonly storage: StorageService) {
    super();
  }

  async process(job: Job<ConversionJobData>): Promise<ConversionJobResult> {
    const { documentVersionId, objectKey, mimeType } = job.data;
    this.logger.log(`Converting document version ${documentVersionId} (${objectKey})`);

    const original = await this.storage.getObjectBuffer(objectKey);

    const form = new FormData();
    form.append('files', original, { filename: 'document', contentType: mimeType });

    const gotenbergUrl = process.env.GOTENBERG_URL ?? 'http://gotenberg:3000';
    const response = await axios.post<Buffer>(`${gotenbergUrl}/forms/libreoffice/convert`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
    });

    const previewObjectKey = `${objectKey}-preview-${randomUUID()}.pdf`;
    await this.storage.putObject(previewObjectKey, Buffer.from(response.data), 'application/pdf');

    return { documentVersionId, previewObjectKey };
  }
}
