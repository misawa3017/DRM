import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobData, ConversionJobResult } from '@drm/shared';
import axios from 'axios';
import FormData from 'form-data';
import { StorageService } from '../storage/storage.service';

// Gotenberg's LibreOffice route picks its converter from the uploaded
// filename's extension, not from the multipart Content-Type header --
// confirmed against this repo's own running Gotenberg service: POST'ing
// with an extensionless filename (e.g. "document") returns HTTP 400, while
// the identical request with a ".txt" filename returns 200. apps/api's
// DocumentsService names MinIO objects `${documentId}/${versionId}` (see
// apps/api/src/documents/documents.service.ts) with no extension, and
// ConversionJobData carries no original filename either, so mimeType is the
// only signal available here to reconstruct a plausible extension.
const MIME_EXTENSIONS: Record<string, string> = {
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
};

function extensionForMimeType(mimeType: string): string {
  const mapped = MIME_EXTENSIONS[mimeType];
  if (mapped) return mapped;
  // Best-effort fallback for simple "type/subtype" mimetypes Gotenberg/
  // LibreOffice might still recognize (e.g. image/png -> png); strips a
  // leading "vnd." vendor prefix some mimetypes carry on the subtype.
  const subtype = mimeType.split('/').pop();
  return subtype ? subtype.replace(/^vnd\./, '') : 'bin';
}

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

    const filename = `document.${extensionForMimeType(mimeType)}`;
    const form = new FormData();
    form.append('files', original, { filename, contentType: mimeType });

    const gotenbergUrl = process.env.GOTENBERG_URL ?? 'http://gotenberg:3000';
    const response = await axios.post<Buffer>(`${gotenbergUrl}/forms/libreoffice/convert`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      // Axios has no default timeout, so a hung Gotenberg would otherwise
      // hold this worker's job-processing slot indefinitely. 120s is
      // comfortably above the 17.7s worst-case latency measured during
      // Task 6's verification under load.
      timeout: 120000,
    });

    // Deterministic key (not a random UUID per attempt): only the last
    // completed job's result is ever referenced from Postgres
    // (DocumentVersion.previewObjectKey), so a random key per attempt just
    // orphans every earlier MinIO object -- especially now that this job
    // has a real retry policy (see DocumentsService.maybeEnqueueConversion),
    // where a retry would otherwise leave a stale object behind on every
    // failed attempt. A retry now simply overwrites the same key.
    const previewObjectKey = `${objectKey}-preview.pdf`;
    await this.storage.putObject(previewObjectKey, Buffer.from(response.data), 'application/pdf');

    return { documentVersionId, previewObjectKey };
  }
}
