CREATE TYPE "DocumentStatus" AS ENUM ('active', 'expired');

ALTER TABLE "folders"
ADD COLUMN "watermarkEnabled" BOOLEAN;

ALTER TABLE "documents"
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "status" "DocumentStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "watermarkEnabled" BOOLEAN;

ALTER TYPE "AuditAction" ADD VALUE 'document_expired';
ALTER TYPE "AuditAction" ADD VALUE 'document_expiry_updated';
ALTER TYPE "AuditAction" ADD VALUE 'document_watermark_updated';
ALTER TYPE "AuditAction" ADD VALUE 'folder_watermark_updated';

CREATE INDEX "documents_status_expiresAt_idx" ON "documents"("status", "expiresAt");
