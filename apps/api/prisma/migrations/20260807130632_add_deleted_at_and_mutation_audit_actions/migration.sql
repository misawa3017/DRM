-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'folder_rename';
ALTER TYPE "AuditAction" ADD VALUE 'folder_move';
ALTER TYPE "AuditAction" ADD VALUE 'folder_delete';
ALTER TYPE "AuditAction" ADD VALUE 'document_rename';
ALTER TYPE "AuditAction" ADD VALUE 'document_move';
ALTER TYPE "AuditAction" ADD VALUE 'document_delete';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "folders" ADD COLUMN     "deletedAt" TIMESTAMP(3);
