export const QUEUE_DOCUMENT_CONVERSION = 'document-conversion';

export interface ConversionJobData {
  documentVersionId: string;
  objectKey: string;
  mimeType: string;
}

export interface ConversionJobResult {
  documentVersionId: string;
  previewObjectKey: string;
}
