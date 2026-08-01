-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "details" JSONB,
ADD COLUMN     "hashVersion" INTEGER NOT NULL DEFAULT 1;
