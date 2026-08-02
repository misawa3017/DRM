-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'virus_detected';

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "previewObjectKey" TEXT;
