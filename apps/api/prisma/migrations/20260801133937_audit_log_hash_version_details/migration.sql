-- Note: this migration's DEFAULT 1 does NOT backfill hashVersion for rows
-- that already existed before it ran -- any such row is actually hashed
-- under the pre-versioning legacy format (hashVersion 0), not 1, and will
-- fail AuditService.verifyChain() until correctly relabeled. If you're
-- applying this migration to a database that already has audit_logs rows,
-- run ../scripts/backfill-hash-version.ts against it afterward (see that
-- script's header comment for usage and exactly what it does).
-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "details" JSONB,
ADD COLUMN     "hashVersion" INTEGER NOT NULL DEFAULT 1;
